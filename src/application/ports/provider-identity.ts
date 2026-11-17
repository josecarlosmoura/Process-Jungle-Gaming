export const PROVIDER_IDENTITY_INTERFACE = Symbol("ProviderIdentityPort");

export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  identify(request: unknown): ProviderIdentity | undefined;
}
