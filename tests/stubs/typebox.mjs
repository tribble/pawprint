// Stub for `typebox` (pi tool parameter schemas). Extensions only build schemas
// with it; tests never validate against them, so plain objects will do.
const schema = (type) => (opts = {}) => ({ type, ...opts });
export const Type = {
  Object: (properties, opts = {}) => ({ type: "object", properties, ...opts }),
  String: schema("string"),
  Boolean: schema("boolean"),
  Number: schema("number"),
  Optional: (s) => ({ ...s, optional: true }),
};
