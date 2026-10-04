import { isSwaggerEnabled } from './swagger.config';

describe('isSwaggerEnabled', () => {
  describe('Production environment (NODE_ENV=production)', () => {
    it('defaults to false when ENABLE_SWAGGER is not set', () => {
      expect(isSwaggerEnabled('production', undefined)).toBe(false);
    });

    it('returns false when ENABLE_SWAGGER=false', () => {
      expect(isSwaggerEnabled('production', 'false')).toBe(false);
    });

    it('returns false when ENABLE_SWAGGER is empty or arbitrary non-true string', () => {
      expect(isSwaggerEnabled('production', '')).toBe(false);
      expect(isSwaggerEnabled('production', '1')).toBe(false);
    });

    it('returns true ONLY when ENABLE_SWAGGER is explicitly "true"', () => {
      expect(isSwaggerEnabled('production', 'true')).toBe(true);
    });
  });

  describe('Development environment (NODE_ENV=development)', () => {
    it('defaults to true when ENABLE_SWAGGER is not set', () => {
      expect(isSwaggerEnabled('development', undefined)).toBe(true);
    });

    it('returns true when ENABLE_SWAGGER=true', () => {
      expect(isSwaggerEnabled('development', 'true')).toBe(true);
    });

    it('returns false when ENABLE_SWAGGER=false is explicitly set', () => {
      expect(isSwaggerEnabled('development', 'false')).toBe(false);
    });
  });

  describe('Test environment (NODE_ENV=test)', () => {
    it('defaults to true when ENABLE_SWAGGER is not set', () => {
      expect(isSwaggerEnabled('test', undefined)).toBe(true);
    });

    it('returns false when ENABLE_SWAGGER=false', () => {
      expect(isSwaggerEnabled('test', 'false')).toBe(false);
    });
  });
});
