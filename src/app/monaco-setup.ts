// Monaco worker bootstrap — must be imported before any `monaco-editor` import
// that creates an editor.
//
// Vite's `?worker` import compiles each worker as a real Web Worker module
// that works in both `npm run dev` and the packaged Electron build.
//
// `editor.worker` is mandatory (diff computation, link detection, background
// tokenization). Language workers (JSON / CSS / HTML / TS) provide folding,
// document symbols, validation, and autocomplete — without them Monaco logs
// "Missing requestHandler or method: …" when it tries to call into the worker
// for language-aware features.
//
// Vite emits each as a separate chunk; they're loaded lazily on first use of
// the matching language, so unused workers cost nothing at runtime.

// monaco-editor 0.56 reworked its "exports" map so that the "./*" subpath
// pattern maps to "./esm/vs/*.js" — i.e. the "esm/vs/" prefix (and ".js") are
// injected by the package itself. The old "monaco-editor/esm/vs/..." specifiers
// now double up to "esm/vs/esm/vs/..." and fail to resolve, so drop the prefix.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

if (typeof self !== "undefined" && !self.MonacoEnvironment) {
  self.MonacoEnvironment = {
    getWorker(_id: string, label: string): Worker {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}
