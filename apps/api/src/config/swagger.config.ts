/**
 * Determines whether Swagger OpenAPI documentation should be enabled based on environment.
 * Hardened production default: OFF unless explicitly ENABLE_SWAGGER=true.
 * In development and test environments: ON unless explicitly disabled with ENABLE_SWAGGER=false.
 */
export function isSwaggerEnabled(
  nodeEnv = process.env.NODE_ENV,
  enableSwagger = process.env.ENABLE_SWAGGER,
): boolean {
  const isProduction = nodeEnv === 'production';
  return (
    enableSwagger === 'true' ||
    (!isProduction && enableSwagger !== 'false')
  );
}
