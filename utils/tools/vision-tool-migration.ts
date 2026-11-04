/** Storage/prompt migration only. Legacy names are never registered or executable. */
const legacy =
  /^vision_(click|drag|input|hover|keyboard|scroll|mark|inspect|zoom|check)$/;
export function migrateVisionToolId(id: string): string {
  return legacy.test(id) ? "vision_gui" : id;
}
export function migrateVisionToolPrompt(prompt: string): string {
  return prompt
    .replace(
      /\bvision_(click|drag|input|hover|keyboard|scroll|mark|inspect|zoom|check)\s*\(\s*\{\s*\}\s*\)/g,
      (_name, action: string) => `vision_gui({"action":"${action}"})`,
    )
    .replace(
      /\bvision_(click|drag|input|hover|keyboard|scroll|mark|inspect|zoom|check)\s*\(\s*\{/g,
      (_name, action: string) => `vision_gui({"action":"${action}",`,
    )
    .replace(
      /\bvision_(click|drag|input|hover|keyboard|scroll|mark|inspect|zoom|check)\s*\(/g,
      (_name, action: string) => `vision_gui(action="${action}", `,
    )
    .replace(
      /\bvision_(click|drag|input|hover|keyboard|scroll|mark|inspect|zoom|check)\b/g,
      (_name, action: string) => `vision_gui(action="${action}")`,
    );
}
