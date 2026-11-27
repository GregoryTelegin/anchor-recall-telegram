import { invalid, keys, record } from "./protocol";
import { evaluateCompanionExercise, validateCompanionExercise, validateCompanionPermutation, type CompanionExercise, type CompanionExerciseResponse } from "./exercises";
import { extractClozeAnswers } from "../cards/recall-test-core";
import { isExactTestAnswerCorrect } from "../cards/recall-core";

/** Private comparison evidence only; submitted free text is never retained. */
export type CompanionExerciseFeedback = { kind: "choice"; selectedOptionIndexes: number[] }
  | { kind: "cloze"; matchedBlanks: boolean[] }
  | { kind: "matching"; matches: number[] }
  | { kind: "ordering"; order: number[] };
export interface CompanionExerciseFeedbackResponse extends CompanionExerciseResponse {}

export function validateCompanionExerciseFeedback(feedback: unknown, exercise?: CompanionExercise): asserts feedback is CompanionExerciseFeedback {
  record(feedback);
  if (exercise !== undefined) validateCompanionExercise(exercise);
  if (feedback.kind === "choice") {
    keys(feedback, ["kind", "selectedOptionIndexes"]);
    const selected = feedback.selectedOptionIndexes;
    invalid(Array.isArray(selected) && selected.length <= 12
      && Array.from(selected).every((index, i) => Number.isSafeInteger(index) && index >= 0 && index < 12
        && (i === 0 || Number(selected[i - 1]) < index)));
    if (exercise !== undefined) {
      invalid(exercise.kind === "single" || exercise.kind === "multiple");
      invalid(selected.every(index => index < exercise.options.length) && (exercise.kind !== "single" || selected.length <= 1));
    }
  } else if (feedback.kind === "matching" || feedback.kind === "ordering") {
    const matching = feedback.kind === "matching";
    keys(feedback, ["kind", matching ? "matches" : "order"]);
    if (exercise !== undefined) invalid(matching ? exercise.kind === "matching" : exercise.kind === "ordering");
    validateCompanionPermutation(matching ? feedback.matches : feedback.order, exercise?.kind === "matching" ? exercise.pairs.length : exercise?.kind === "ordering" ? exercise.orderItems.length : undefined);
  } else {
    keys(feedback, ["kind", "matchedBlanks"]);
    invalid(feedback.kind === "cloze" && Array.isArray(feedback.matchedBlanks) && feedback.matchedBlanks.length >= 1 && feedback.matchedBlanks.length <= 12
      && Array.from(feedback.matchedBlanks).every(value => typeof value === "boolean"));
    if (exercise !== undefined) invalid(exercise.kind === "cloze" && feedback.matchedBlanks.length === extractClozeAnswers(exercise.clozeTemplate).length);
  }
}

export function createCompanionExerciseFeedback(exercise: CompanionExercise, response: CompanionExerciseFeedbackResponse): CompanionExerciseFeedback {
  const value: unknown = response; record(value); keys(value, ["selectedOptionIndexes", "clozeAnswers", "matches", "order"]);
  // Share the existing response bounds and exercise validation before deriving any detail.
  evaluateCompanionExercise(exercise, response);
  let feedback: CompanionExerciseFeedback;
  if (exercise.kind === "cloze") {
    const expected = extractClozeAnswers(exercise.clozeTemplate), answers = response.clozeAnswers ?? [];
    invalid(answers.length === expected.length, "cloze response count differs");
    feedback = { kind: "cloze", matchedBlanks: expected.map((answer, index) => isExactTestAnswerCorrect(answers[index], answer, exercise.answerMatchMode)) };
  } else if (exercise.kind === "matching") {
    feedback = { kind: "matching", matches: [...response.matches!] };
  } else if (exercise.kind === "ordering") {
    feedback = { kind: "ordering", order: [...response.order!] };
  } else {
    invalid((response.clozeAnswers?.length ?? 0) === 0, "choice response contains cloze answers");
    const selectedOptionIndexes = [...(response.selectedOptionIndexes ?? [])].sort((a, b) => a - b);
    invalid(new Set(selectedOptionIndexes).size === selectedOptionIndexes.length, "duplicate selected option");
    feedback = { kind: "choice", selectedOptionIndexes };
  }
  validateCompanionExerciseFeedback(feedback, exercise); return feedback;
}

export function feedbackMatchesAnswer(exercise: CompanionExercise, feedback: CompanionExerciseFeedback): boolean {
  validateCompanionExerciseFeedback(feedback, exercise);
  return feedback.kind === "choice" ? evaluateCompanionExercise(exercise, { selectedOptionIndexes: feedback.selectedOptionIndexes })
    : feedback.kind === "matching" ? evaluateCompanionExercise(exercise, { matches: feedback.matches })
    : feedback.kind === "ordering" ? evaluateCompanionExercise(exercise, { order: feedback.order }) : feedback.matchedBlanks.every(Boolean);
}
