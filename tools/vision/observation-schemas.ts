export const pointSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "number", minimum: 0, maximum: 1000 },
    y: { type: "number", minimum: 0, maximum: 1000 },
  },
  required: ["x", "y"],
};
export const regionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...pointSchema.properties,
    width: { type: "number", minimum: 0.001, maximum: 1000 },
    height: { type: "number", minimum: 0.001, maximum: 1000 },
  },
  required: ["x", "y", "width", "height"],
};
