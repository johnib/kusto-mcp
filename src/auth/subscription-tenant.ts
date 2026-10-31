/**
 * GetTokenOptions flag: ask az for its current subscription's tenant (no
 * `--tenant`) instead of the default (`organizations`). Honoured only when
 * the az step was built with subscriptionTenantFallback (no AZURE_TENANT_ID);
 * set per request, so it never changes what other callers get.
 */
export const SUBSCRIPTION_TENANT = 'kustoMcpSubscriptionTenant';
