// i18next type augmentation is intentionally omitted.
// The resources structure has top-level section keys (common, nav, settings, etc.)
// that i18next's type system misinterprets as namespaces, generating colon-separated
// keys (e.g. "common:noData") instead of the dot-separated keys (e.g. "common.noData")
// that we use throughout the codebase. Without augmentation, t() accepts any string,
// which is sufficient — keys are validated at runtime.
export {};
