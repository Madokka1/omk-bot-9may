// Формат 9:16 для 9 мая
const MAY9_OUTPUT_FORMAT =
  "Output format: 9:16 portrait. " +
  "NO hard decorative frame. Clean composition. " +
  "Edges: soft watercolor paper effect — slightly uneven, gently faded edges on all four sides, " +
  "as if painted on watercolor paper with natural bleeding at the borders. Subtle and delicate, NOT a thick border. " +
  "IMPORTANT COMPOSITION RULE: The image is divided into three zones. " +
  "Zone 1 (top 75% of image): main illustration with person, background, sky, doves. " +
  "Zone 2 (next 15% of image, from 75% to 90%): horizontal Saint George ribbon in watercolor style — " +  "orange and black stripes, soft brush strokes, watercolor texture. " +  "The ribbon is gently WAVY, like a real fabric ribbon flowing horizontally across the full width. " +
  "Zone 3 (bottom 10% of image): completely white/empty area for logo placement. " +
  "LETTERING: large expressive hand-lettered Cyrillic brush script 'С Днём Победы!' placed ON TOP of the ribbon, " +
  "overlapping it freely, text may extend above and below the ribbon edges — that is intentional and desired. " +
  "Flowing dynamic brush calligraphy, Soviet celebration style, bold and expressive. " +
  "Text color: deep red or crimson fill, clean white outline/stroke around each letter, NO drop shadow, NO glow, NO dark outline. " +
  "Style reference: classic Russian Victory Day celebration lettering, similar to vintage Soviet holiday posters. " +
  "No watermark area. No AI signatures anywhere. ";

// Базовые блоки 9 мая
const MAY9_REPAINT =
  "REPAINT this photo entirely as a watercolor painted illustration. " +
  "Do NOT paste or cut out the original face/person onto a new background. " +
  "Fully redraw all people in the same watercolor painting style as the background. NO photo collage. NO photorealistic face pasted over illustration. ";

const MAY9_STYLE_BASE =
  "Watercolor illustration style, soft brush strokes, gentle color bleeding, transparent washes, " +
  "hand-painted feel, warm and emotional, NOT photorealistic, NOT digital render. " +
  "Victory Day May 9th celebration, Russian patriotic theme, nostalgic and heartfelt mood. " +
  "Visual elements: white doves in flight, Saint George ribbons (orange and black stripes), " +
  "red carnations, spring flowers, soft golden sunlight, festive atmosphere. ";

const MAY9_SUBJECT =
  "Preserve original identity, facial features, proportions, and likeness of all people. Maintain recognizability. No distortion. " +
  "Slightly enhance composition to resemble a Victory Day celebration scene, warm and forward-looking, but keep original structure. ";

const MAY9_FINISH =
  "Subtle watercolor paper texture, soft edges, light grain, gentle vintage finish. " +
  "Strictly Victory Day theme only, no other holidays, no modern elements. ";

const MAY9_COMMON_BASE =
  "Transform this photo into a Victory Day May 9th watercolor postcard illustration. " +
  MAY9_REPAINT +
  MAY9_STYLE_BASE +
  MAY9_SUBJECT +
  MAY9_FINISH +
  MAY9_OUTPUT_FORMAT;

// Промпт
function buildMay9Prompt() {
  return (
    MAY9_COMMON_BASE +
    "Background: Red Square with Kremlin towers, red banners, warm golden sunset light, " +
    "crowds with flowers and flags softly painted in background. " +
    "Subject is holding a bouquet of red carnations tied with Saint George ribbon IN THEIR HANDS in front of them. " +
    "NO flowers growing from behind the person. NO flowers on clothing. NO text or prints on clothing. " +
    "White doves flying above in the sky. " +
    "Bright and light color palette, airy and emotional, warm golden tones, NO dark areas, NO heavy shadows. " +
    "NO PROMPT TEXT. NO captions. NO descriptions anywhere in the image. NO English text. "
  );
}