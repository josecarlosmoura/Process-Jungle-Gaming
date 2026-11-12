import type { SQSClientConfig } from "@aws-sdk/client-sqs";

export interface SqsConnectionEnv {
  localstackEndpoint: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
}

export function buildSqsClientConfig(env: SqsConnectionEnv): SQSClientConfig {
  return {
    endpoint: env.localstackEndpoint,
    region: env.awsRegion,
    credentials: {
      accessKeyId: env.awsAccessKeyId,
      secretAccessKey: env.awsSecretAccessKey,
    },
  };
}
