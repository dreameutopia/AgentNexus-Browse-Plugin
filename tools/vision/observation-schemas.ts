/** 坐标换算纪律是防误点的第一道闸：像素值直接当 0..1000 坐标发出，
 *  会在高分辨率截图（高度 >1000px）上系统性下偏——曾在实际会话中把
 *  「存储和数据库」点成下方的 Realtime。schema 描述在参数层持续提醒。 */
export const pointSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: {
      type: "number",
      minimum: 0,
      maximum: 1000,
      description:
        "x = pixel column ÷ image width × 1000. Normalized to the FULL uncropped screenshot; never raw pixels.",
    },
    y: {
      type: "number",
      minimum: 0,
      maximum: 1000,
      description:
        "y = pixel row ÷ image height × 1000. Normalized to the FULL uncropped screenshot; never raw pixels.",
    },
  },
  required: ["x", "y"],
};
export const regionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...pointSchema.properties,
    width: {
      type: "number",
      minimum: 0.001,
      maximum: 1000,
      description: "Region size in the same 0..1000 normalized units.",
    },
    height: {
      type: "number",
      minimum: 0.001,
      maximum: 1000,
      description: "Region size in the same 0..1000 normalized units.",
    },
  },
  required: ["x", "y", "width", "height"],
};
