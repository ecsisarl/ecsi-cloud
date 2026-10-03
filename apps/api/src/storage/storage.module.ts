import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export const S3 = Symbol('S3');

/**
 * Accès au stockage objet S3 compatible (SeaweedFS en développement, S3 managé en production).
 * Les fichiers sont privés : ils ne sont jamais servis directement par le stockage, mais par
 * l'API après contrôle d'accès (logos des entreprises).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3) private readonly s3: S3Client,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get bucket(): string {
    return this.env.S3_BUCKET;
  }

  async onModuleInit(): Promise<void> {
    if (!this.env.S3_AUTO_CREATE_BUCKET) return;
    try {
      await this.ping();
    } catch {
      try {
        await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Bucket « ${this.bucket} » créé (développement)`);
      } catch (error) {
        // Le stockage n'est pas indispensable au démarrage : l'état est visible dans /health.
        this.logger.warn(`Création du bucket impossible : ${(error as Error).message}`);
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

@Global()
@Module({
  providers: [
    {
      provide: S3,
      inject: [ENV],
      useFactory: (env: Env) =>
        new S3Client({
          region: env.S3_REGION,
          ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }),
    },
    StorageService,
  ],
  exports: [S3, StorageService],
})
export class StorageModule implements OnApplicationShutdown {
  constructor(@Inject(S3) private readonly s3: S3Client) {}

  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}
