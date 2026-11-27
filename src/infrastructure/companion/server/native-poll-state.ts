import { invalid, keys, record, timestamp, token, type CompanionSnapshot, type SelectedCard } from "../../../domain/companion/protocol";
import { nativePollView, validNativePollId, validateNativePollPayload } from "../../../features/companion/native-poll";
import { canonical } from "./bridge-contract";
import type { Outbound, ServerState } from "./runtime";

export function storedPollCard(s: ServerState, row: Outbound): { card: SelectedCard; snapshot: CompanionSnapshot } | undefined {
  const panel = row.pollPanel, session = s.studySession;
  if (!panel || session?.id !== panel.sessionId) return;
  const cards = [...(session.current ? [session.current] : []), ...(session.frames ?? []), ...session.results.flatMap(result => result.card ? [result.card] : []), ...session.snapshot.cards];
  const card = cards.find(card => card.id === panel.cardId && card.revision === panel.revision);
  return card ? { card, snapshot: session.snapshot } : undefined;
}

/** Active polls must retain an exact authored source; confirmed and uncertain sends remain auditable after a session ends. */
export function validateStoredPoll(s: ServerState, row: Outbound): void {
  const panel = row.pollPanel; record(panel); keys(panel, ["cardId", "revision", "sessionId", "expiresAt", "pollId", "sealed", "selection"]);
  token(panel.cardId); token(panel.revision); token(panel.sessionId); timestamp(panel.expiresAt); timestamp(row.snapshotSequence);
  invalid(panel.expiresAt > 0 && row.method === "sendPoll" && row.sessionContent?.sessionId === panel.sessionId
    && row.sessionContent.cardId === panel.cardId && row.sessionContent.revision === panel.revision
    && !row.answerHandle && !row.mediaPlaceholder && !row.ratingPanel && !row.questionPanel && !row.hintPanel && !row.hintLease && !row.sessionPanel);
  invalid(panel.sealed === undefined || panel.sealed === true);
  invalid(row.status === "sent" ? validNativePollId(panel.pollId) && Number.isSafeInteger(row.messageId) && Number(row.messageId) > 0 : panel.pollId === undefined);
  validateNativePollPayload(row.payload);
  invalid(row.payload.close_date === undefined || row.payload.close_date === Math.floor(panel.expiresAt / 1000));
  const source = storedPollCard(s, row);
  invalid(row.status !== "queued" || source !== undefined, "poll source missing");
  if (source) {
    invalid(panel.expiresAt <= source.snapshot.expiresAt, "poll lease differs");
    const view = nativePollView(source.card); invalid(view, "poll source unsupported");
    const { chat_id: _chat, disable_notification: _silent, close_date: _close, reply_markup: _markup, ...storedView } = row.payload;
    invalid(canonical(storedView) === canonical(view), "poll source differs");
  }
  if (panel.selection !== undefined) {
    invalid(panel.sealed === true && Array.isArray(panel.selection) && panel.selection.length <= 12 && new Set(panel.selection).size === panel.selection.length
      && panel.selection.every(index => Number.isSafeInteger(index) && index >= 0 && index < 12));
    if (source) {
      const exercise = source.card.exercise; invalid(exercise && (exercise.kind === "single" || exercise.kind === "multiple"));
      invalid(panel.selection.every(index => index < exercise.options.length) && (exercise.kind !== "single" || panel.selection.length <= 1));
    }
  }
  const kinds: Record<string, string> = { "Показать ответ": "reveal", "Подсказка": "hint", "Подсказки": "hint-panel", "Пропустить сейчас": "skip-card" };
  for (const buttons of row.payload.reply_markup?.inline_keyboard ?? []) {
    const button = buttons[0], handle = s.handles.find(handle => handle.id === button.callback_data);
    if (!handle) continue; // Retired opaque handles are retained only in historical message payloads.
    const action = handle.action;
    invalid(action.kind === kinds[button.text] && handle.expiresAt <= panel.expiresAt);
    if (action.kind === "hint-panel") {
      const target = s.outbox.find(target => target.id === action.panelId), hint = target?.hintPanel;
      invalid(hint?.cardId === panel.cardId && hint.revision === panel.revision && hint.sessionId === panel.sessionId
        && target?.sessionContent?.sessionId === panel.sessionId && Number.isSafeInteger(action.index)
        && Number(action.index) >= 0 && Number(action.index) < hint.count && typeof action.collapsed === "boolean");
    } else {
      invalid(action.cardId === panel.cardId && action.revision === panel.revision && handle.sequence === row.snapshotSequence && action.sequence === row.snapshotSequence);
      if (source) {
        invalid(handle.epoch === source.snapshot.epoch && action.scope === source.snapshot.scope && action.epoch === source.snapshot.epoch);
        if (action.kind === "hint") invalid(Number.isSafeInteger(action.index) && Number(action.index) >= 0 && Number(action.index) < (source.card.hints?.length ?? 0));
      }
    }
  }
}
