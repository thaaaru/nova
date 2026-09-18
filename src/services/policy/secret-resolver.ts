/**
 * Secrets are referenced by opaque ID everywhere in graph state, prompts,
 * logs, and reports — never by value. This resolver is the only place an
 * actual secret value is looked up, and it is called at the last possible
 * moment inside the browser executor, immediately before filling a field;
 * the resolved value is never written back into TestRunState, never
 * logged, and never included in a screenshot's surrounding context by
 * design (callers must mask the field before capturing evidence).
 *
 * The MVP resolves from process environment variables named
 * `NOVA_SECRET_<ID>`; production deployments should replace this with a
 * real secrets manager without changing the interface.
 */
export interface SecretResolver {
  resolve(secretId: string): string | undefined;
}

export class EnvSecretResolver implements SecretResolver {
  resolve(secretId: string): string | undefined {
    const key = `NOVA_SECRET_${secretId.toUpperCase()}`;
    return process.env[key];
  }
}

/** Matches a step value like "secret:standard_user_password" for opaque-ID lookup. */
const SECRET_REFERENCE_PATTERN = /^secret:(.+)$/;

export function isSecretReference(value: string): boolean {
  return SECRET_REFERENCE_PATTERN.test(value);
}

export function resolveIfSecretReference(value: string, resolver: SecretResolver): string {
  const match = SECRET_REFERENCE_PATTERN.exec(value);
  if (!match) {
    return value;
  }
  const resolved = resolver.resolve(match[1]);
  if (resolved === undefined) {
    throw new Error(`Secret reference "${value}" did not resolve to a configured value.`);
  }
  return resolved;
}
