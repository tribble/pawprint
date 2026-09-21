// Stub for runtime imports from @earendil-works/pi-ai. StringEnum is the Google-compatible
// string enum for tool schemas; tests never validate against it, so a plain object will do.
export const StringEnum = (values, opts = {}) => ({ type: "string", enum: values, ...opts });
