export const LARK_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export async function createLarkBaseClient(options = {}) {
  const { keychainService, env = process.env, ...clientOptions } = options;
  let provider;
  try {
    provider = await import("@live-agency-skills/lark-base-client");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "Lark Base provider is not installed; run this skill from the canonical provider runtime",
        { cause: error },
      );
    }
    throw error;
  }
  if (typeof provider.LarkBaseClient?.fromEnvironment !== "function") {
    throw new TypeError("installed Lark Base provider is incompatible");
  }
  const selectedService = env.LARK_KEYCHAIN_SERVICE?.trim() || keychainService?.trim();
  const effectiveEnv = selectedService
    ? { ...env, LARK_KEYCHAIN_SERVICE: selectedService }
    : env;
  return provider.LarkBaseClient.fromEnvironment({ ...clientOptions, env: effectiveEnv });
}
