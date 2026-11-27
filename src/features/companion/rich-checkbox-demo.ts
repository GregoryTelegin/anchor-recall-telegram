import { invalid, keys, record } from "../../domain/companion/protocol";

export const RICH_CHECKBOX_DEMO_QUESTION = "Выбери все чётные числа.";
export const RICH_CHECKBOX_DEMO_OPTIONS = ["2", "3", "4", "6"] as const;
const footer = "Пробный интерфейс · без истории и FSRS.";
const feedback = (selected: readonly number[]) => selected.length === 3 && selected[0] === 0 && selected[1] === 2 && selected[2] === 3
  ? "✅ Верно: 2, 4 и 6." : "❌ Не совсем. Чётные числа: 2, 4 и 6.";
export interface RichCheckboxDemoCallbacks { toggleHandles: readonly [string, string, string, string]; checkHandle: string; resetHandle: string; }
export interface RichCheckboxDemoState extends RichCheckboxDemoCallbacks { selectedOptionIndexes: readonly number[]; checked: boolean; }
export interface RichCheckboxDemoMessage { blocks: Record<string, unknown>[]; skip_entity_detection: true; }
export interface RichCheckboxDemoPayload { chat_id: number; rich_message: RichCheckboxDemoMessage; disable_notification?: true; message_id?: number; }

function handle(value: unknown): asserts value is string { invalid(typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)); }
function validateState(value: RichCheckboxDemoState): void {
  record(value); keys(value, ["selectedOptionIndexes", "toggleHandles", "checkHandle", "resetHandle", "checked"]);
  invalid(Array.isArray(value.selectedOptionIndexes) && value.selectedOptionIndexes.length <= 4
    && Array.from(value.selectedOptionIndexes).every((index, i) => Number.isSafeInteger(index) && index >= 0 && index < 4 && (i === 0 || value.selectedOptionIndexes[i - 1] < index)));
  invalid(Array.isArray(value.toggleHandles) && value.toggleHandles.length === 4 && typeof value.checked === "boolean");
  for (const id of [...value.toggleHandles, value.checkHandle, value.resetHandle]) handle(id);
  invalid(new Set([...value.toggleHandles, value.checkHandle, value.resetHandle]).size === 6);
}
/** Static demonstration only: no authored content, media, learner IDs, grades or scheduling state. */
export function richCheckboxDemoView(state: RichCheckboxDemoState): RichCheckboxDemoMessage {
  validateState(state);
  return { blocks: [
    { type: "paragraph", text: RICH_CHECKBOX_DEMO_QUESTION },
    { type: "list", items: RICH_CHECKBOX_DEMO_OPTIONS.map((text, index) => ({ has_checkbox: true,
      ...(state.selectedOptionIndexes.includes(index) ? { is_checked: true } : {}),
      blocks: [{ type: "paragraph", text: { type: "button", button: { text, style: "link", callback_data: state.toggleHandles[index] } } }] })) },
    ...(state.checked ? [{ type: "paragraph", text: feedback(state.selectedOptionIndexes) }] : []),
    { type: "buttons", align: "left", buttons: [
      { text: "Проверить ответ", style: "primary", callback_data: state.checkHandle },
      { text: "Сбросить выбор", style: "link", callback_data: state.resetHandle }
    ] },
    { type: "footer", text: footer }
  ], skip_entity_detection: true };
}
function parseMessage(value: unknown): RichCheckboxDemoState {
  record(value); keys(value, ["blocks", "skip_entity_detection"]);
  invalid(value.skip_entity_detection === true && Array.isArray(value.blocks) && (value.blocks.length === 4 || value.blocks.length === 5));
  const blocks = value.blocks;
  const paragraph = (block: unknown): Record<string, unknown> => { record(block); keys(block, ["type", "text"]); invalid(block.type === "paragraph"); return block; };
  invalid(paragraph(blocks[0]).text === RICH_CHECKBOX_DEMO_QUESTION);
  const list = blocks[1]; record(list); keys(list, ["type", "items"]); invalid(list.type === "list" && Array.isArray(list.items) && list.items.length === 4);
  const selectedOptionIndexes: number[] = [], toggles: string[] = [];
  for (let index = 0; index < 4; index++) {
    const item = list.items[index]; record(item); keys(item, ["blocks", "has_checkbox", "is_checked"]);
    invalid(item.has_checkbox === true && (item.is_checked === undefined || item.is_checked === true) && Array.isArray(item.blocks) && item.blocks.length === 1);
    if (item.is_checked === true) selectedOptionIndexes.push(index);
    const richText = paragraph(item.blocks[0]).text; record(richText); keys(richText, ["type", "button"]); invalid(richText.type === "button");
    record(richText.button); keys(richText.button, ["text", "style", "callback_data"]);
    invalid(richText.button.text === RICH_CHECKBOX_DEMO_OPTIONS[index] && richText.button.style === "link"); handle(richText.button.callback_data); toggles.push(richText.button.callback_data);
  }
  const checked = blocks.length === 5;
  if (checked) invalid(paragraph(blocks[2]).text === feedback(selectedOptionIndexes));
  const controls = blocks[blocks.length - 2]; record(controls); keys(controls, ["type", "align", "buttons"]);
  invalid(controls.type === "buttons" && controls.align === "left" && Array.isArray(controls.buttons) && controls.buttons.length === 2);
  for (let index = 0; index < 2; index++) {
    const button = controls.buttons[index]; record(button); keys(button, ["text", "style", "callback_data"]);
    invalid(button.text === (index === 0 ? "Проверить ответ" : "Сбросить выбор") && button.style === (index === 0 ? "primary" : "link")); handle(button.callback_data);
  }
  const note = blocks[blocks.length - 1]; record(note); keys(note, ["type", "text"]); invalid(note.type === "footer" && note.text === footer);
  const state: RichCheckboxDemoState = { selectedOptionIndexes, checked, toggleHandles: toggles as [string, string, string, string],
    checkHandle: controls.buttons[0].callback_data as string, resetHandle: controls.buttons[1].callback_data as string };
  validateState(state); return state;
}
export function validateRichCheckboxDemoMessage(value: unknown): asserts value is RichCheckboxDemoMessage { parseMessage(value); }
export function readRichCheckboxDemoMessage(value: unknown): RichCheckboxDemoState { return parseMessage(value); }
/** Runtime compares these fixed-position callbacks with its private owned demo panel. */
export function richCheckboxDemoCallbacks(value: unknown): RichCheckboxDemoCallbacks {
  const { toggleHandles, checkHandle, resetHandle } = parseMessage(value); return { toggleHandles, checkHandle, resetHandle };
}
export function validateRichCheckboxDemoPayload(value: unknown, editing = false): asserts value is RichCheckboxDemoPayload {
  record(value); keys(value, editing ? ["chat_id", "message_id", "rich_message"] : ["chat_id", "rich_message", "disable_notification"]);
  invalid(Number.isSafeInteger(value.chat_id) && Number(value.chat_id) > 0);
  if (editing) invalid(Number.isSafeInteger(value.message_id) && Number(value.message_id) > 0);
  else invalid(value.disable_notification === true);
  validateRichCheckboxDemoMessage(value.rich_message);
}
