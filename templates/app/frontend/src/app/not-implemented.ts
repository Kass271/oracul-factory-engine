// Contract sync marker (Oracul): a value or branch the contract already has but no slice has implemented yet.
// It returns undefined and never throws at import time, so tests fail on their assertions, not while loading.
// The release check requires that none is left.
export function notImplemented<T = never>(): T {
  return undefined as T;
}
