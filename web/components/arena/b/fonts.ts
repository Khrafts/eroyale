// Compatibility only: /play (components/play/Play.tsx, Predict.tsx) still imports `condensed` and `extra` from here
// until the look-play track restyles it. They are the one look's body and figure faces (app/fonts.ts); the arena
// itself draws with canvasFont from lib/theme.ts. Delete this file once nothing imports it.
export { body as condensed, mono as extra } from "@/app/fonts";
