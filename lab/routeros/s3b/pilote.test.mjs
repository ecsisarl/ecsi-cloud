// node --test lab/routeros/s3b/ : tests du pilote S3B (rapport de validation S3B, §6.3).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, expectStatus, parseBody, problemDetail, routerView } from './pilote-lib.mjs';

describe('pilote S3B', () => {
  it('404 sur un routeur supprimé : erreur API explicite, pas de TypeError', () => {
    const response = { status: 404, json: { status: 404, detail: 'Routeur introuvable' } };
    assert.throws(
      () => expectStatus(response, 200, 'voir'),
      (error) =>
        error instanceof ApiError &&
        error.status === 404 &&
        error.message === 'voir : HTTP 404 (Routeur introuvable)',
    );
  });

  it('statut attendu : renvoie le corps', () => {
    assert.deepEqual(expectStatus({ status: 204, json: null }, [200, 204], 'supprimer'), null);
    assert.deepEqual(expectStatus({ status: 200, json: { id: 'x' } }, 200, 'voir'), { id: 'x' });
  });

  it('corps vide ou non JSON (proxy, 502) : pas d’exception de parsing', () => {
    assert.equal(parseBody(''), null);
    assert.equal(parseBody('<html>502</html>'), null);
    assert.deepEqual(parseBody('{"a":1}'), { a: 1 });
    assert.throws(() => expectStatus({ status: 502, json: null }, 200, 'liste'), /HTTP 502$/);
  });

  it('message d’erreur : detail, sinon title, sinon rien', () => {
    assert.equal(problemDetail({ title: 'Conflict' }), 'Conflict');
    assert.equal(problemDetail({ detail: 'd', title: 't' }), 'd');
    assert.equal(problemDetail(null), '');
  });

  it('routeur jamais collecté (PROVISIONING) : interfaces vides au lieu d’un plantage', () => {
    assert.deepEqual(routerView({ id: 'r', interfaces: undefined }).interfaces, []);
    assert.deepEqual(
      routerView({ id: 'r', interfaces: [{ name: 'ether1', running: true }] }).interfaces,
      ['ether1:up'],
    );
  });
});
