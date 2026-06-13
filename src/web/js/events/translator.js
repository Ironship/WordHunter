import { refreshTranslatorAvailability, bindTranslatorEvents as coreBindTranslator } from "../views/translator.js";

export function bindTranslatorEvents() {
  coreBindTranslator();
  refreshTranslatorAvailability();
}
