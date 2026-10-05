import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { MatchingRepository } from '../src/matching/matching.repository';
import { MatchingError } from '../src/matching/matching-error';
import { evaluateMatching } from '../src/matching/domain/three-way-matching.engine';
import { fixture, line } from './fixtures/matching';

describe('Matching HTTP API (authentication and repository mocked)', () => {
  let app: INestApplication;
  const invoiceId = randomUUID(), resultId = randomUUID();
  const policy = { ...fixture().policy };
  const perfect = { id: resultId, invoiceId, ...evaluateMatching(fixture()) };
  const mismatch = { id: resultId, invoiceId, ...evaluateMatching(fixture({ invoiceItems: [line({ unitPrice: '120' })] })) };
  const repository = {
    match: jest.fn(async () => perfect), result: jest.fn(async () => perfect),
    invoiceResult: jest.fn(async () => perfect), policy: jest.fn(async () => policy),
    updatePolicy: jest.fn(async dto => ({ ...policy, ...dto })),
  };
  const auth = (role = 'accountant') => ['Authorization', 'Bearer ' + role] as const;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthService).useValue({ verifyToken: async token => {
        if (!['accountant', 'admin', 'warehouse', 'buyer', 'finance_manager'].includes(token)) throw new UnauthorizedException();
        return { sub: 'sub-' + token, username: token + '.demo', roles: [token] };
      } }).overrideProvider(MatchingRepository).useValue(repository).compile();
    app = module.createNestApplication();
    // Match production implicit conversion too: decimal DTO transforms inspect raw inputs.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
      transformOptions: { enableImplicitConversion: true } }));
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  it.each(['accountant', 'admin'])('%s may trigger completed match with empty body', async role => {
    const res = await request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth(role)).send({}).expect(200);
    expect(res.body).toMatchObject({ status: 'PASSED', invoiceStatus: 'MATCHED', overallConfidence: null });
    expect(repository.match).toHaveBeenLastCalledWith(invoiceId, expect.objectContaining({ sub: 'sub-' + role, roles: [role] }));
  });
  it('accepts no body', () => request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth()).expect(200));
  it.each(['warehouse', 'buyer', 'finance_manager'])('%s may not trigger matching', role =>
    request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth(role)).expect(403));
  it('anonymous matching is 401', () => request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').expect(401));
  it('invalid bearer is 401', () => request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth('invalid')).expect(401));
  it.each(['accountant', 'admin', 'warehouse', 'buyer', 'finance_manager'])('%s reads results and policy', async role => {
    for (const path of ['/invoices/' + invoiceId + '/match-result', '/match-results/' + resultId, '/matching/policy']) {
      await request(app.getHttpServer()).get(path).set(...auth(role)).expect(200);
    }
  });
  it.each(['/matching/policy', '/invoices/' + invoiceId + '/match-result', '/match-results/' + resultId])('anonymous read %s is 401', path =>
    request(app.getHttpServer()).get(path).expect(401));
  it('invalid path UUID is 400', () => request(app.getHttpServer()).post('/invoices/not-a-uuid/match').set(...auth()).expect(400));
  it.each([{ body: { quantity: '1' } }, { body: { purchaseOrderId: randomUUID() } },
    { body: { policy: { priceTolerancePercent: '100' } } }, { body: [] }])('rejects client matching truth %j',
    ({ body }) => request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth()).send(body).expect(400));
  it('business discrepancy is a completed HTTP 200 result', async () => {
    repository.match.mockResolvedValueOnce(mismatch);
    const res = await request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth()).expect(200);
    expect(res.body).toMatchObject({ status: 'REVIEW_REQUIRED', invoiceStatus: 'EXCEPTION', discrepancyCodes: ['PRICE_MISMATCH'] });
  });
  it.each(['INVALID_INVOICE_STATE', 'MATCH_ALREADY_EXISTS'])('deterministic conflict %s is 409', async code => {
    repository.match.mockRejectedValueOnce(new MatchingError(code, 'Safe conflict.', 409));
    const res = await request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth()).expect(409);
    expect(res.body.errorCode).toBe(code);
  });
  it('missing invoice is 404', async () => {
    repository.match.mockRejectedValueOnce(new MatchingError('INVOICE_NOT_FOUND', 'Invoice not found.', 404));
    await request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth()).expect(404);
  });
  it('missing match result is 404', async () => {
    repository.invoiceResult.mockRejectedValueOnce(new MatchingError('MATCH_RESULT_NOT_FOUND', 'Match result not found.', 404));
    await request(app.getHttpServer()).get('/invoices/' + invoiceId + '/match-result').set(...auth()).expect(404);
  });
  it('technical failure is sanitized 503', async () => {
    repository.match.mockRejectedValueOnce(new Error('SQL SELECT password FROM secret; JWT secret-token C:/secret/path'));
    const res = await request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth()).expect(503);
    expect(res.body.errorCode).toBe('MATCHING_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|password|secret-token|C:\//);
  });
  it('unique-index race fallback is deterministic 409', async () => {
    repository.match.mockRejectedValueOnce({ code: '23505', constraint: 'uq_match_result_invoice' });
    const res = await request(app.getHttpServer()).post('/invoices/' + invoiceId + '/match').set(...auth()).expect(409);
    expect(res.body.errorCode).toBe('MATCH_ALREADY_EXISTS');
  });
  it('admin updates controlled strict decimal tolerances', async () => {
    const res = await request(app.getHttpServer()).patch('/matching/policy').set(...auth('admin'))
      .send({ quantityTolerancePercent: '100.00', priceTolerancePercent: '2.00', taxTolerancePercent: '0', totalTolerancePercent: '0.01' }).expect(200);
    expect(res.body.priceTolerancePercent).toBe('2.00');
    expect(repository.updatePolicy).toHaveBeenLastCalledWith(expect.objectContaining({ priceTolerancePercent: '2.00' }),
      expect.objectContaining({ sub: 'sub-admin' }));
  });
  it.each(['accountant', 'warehouse', 'buyer', 'finance_manager'])('%s cannot edit policy', role =>
    request(app.getHttpServer()).patch('/matching/policy').set(...auth(role)).send({ priceTolerancePercent: '2.00' }).expect(403));
  it('anonymous policy update is 401', () => request(app.getHttpServer()).patch('/matching/policy').send({ priceTolerancePercent: '2' }).expect(401));
  it.each([2, null, true, '-1', '100.01', '1.001', '1e1', 'NaN', 'Infinity', '', ' 1', '1 ', '.5'])(
    'rejects invalid policy value %j even with implicit conversion', priceTolerancePercent =>
      request(app.getHttpServer()).patch('/matching/policy').set(...auth('admin')).send({ priceTolerancePercent }).expect(400));
  it('rejects unknown policy fields', () => request(app.getHttpServer()).patch('/matching/policy').set(...auth('admin')).send({ isActive: true }).expect(400));
  it('rejects empty policy update', () => request(app.getHttpServer()).patch('/matching/policy').set(...auth('admin')).send({}).expect(400));
});
