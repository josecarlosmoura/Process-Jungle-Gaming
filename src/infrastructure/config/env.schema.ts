import { z } from "zod";

// z.string().url() delega ao parser WHATWG URL, que aceita "localhost:4566" como uma URL
// valida de esquema "localhost:" - sem isto, um LOCALSTACK_ENDPOINT sem "http://" passaria
// a validacao e so quebraria nas camadas que de fato tentam conectar (T005).
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const envSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  LOCALSTACK_ENDPOINT: z.string().refine(isAbsoluteHttpUrl, {
    message: "must be an absolute http(s) URL",
  }),
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type EnvSchema = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvSchema {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuração de ambiente inválida - ${issues}`);
  }

  return result.data;
}
