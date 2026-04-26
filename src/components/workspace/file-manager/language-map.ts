// Re-export the shared config table so frontend imports keep working with
// the same path. Single source of truth lives in config/language-map.js.
export {
  guessLanguageFromPath,
  guessMonacoLanguage,
  LANG_BY_EXT,
  SPECIAL_FILENAMES,
} from "../../../../config/language-map.js";
