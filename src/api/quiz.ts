import type { APIRequestContext, APIResponse } from '@playwright/test';

export interface QuizQuestion {
  question: string;
  options: string[];
  /** Must never be present — the server strips it. Typed so a test can assert. */
  correctIndex?: number;
}

export interface QuizSubmitResult {
  score: number;
  passed: boolean;
  passingScore: number;
  xpAwarded: number;
  alreadyCompleted: boolean;
}

export function listLessons(api: APIRequestContext): Promise<APIResponse> {
  return api.get('lessons');
}

export function getQuiz(api: APIRequestContext, quizId: string): Promise<APIResponse> {
  return api.get(`quiz/${quizId}`);
}

/**
 * Graded server-side. It used to accept the `score` the client worked out from
 * a `correctIndex` that shipped with the questions, so `{ score: 100 }`
 * collected the XP for a lesson nobody opened.
 */
export function submitQuiz(
  api: APIRequestContext,
  data: Record<string, unknown>,
): Promise<APIResponse> {
  return api.post('quiz/submit', { data });
}

export function completeLesson(api: APIRequestContext, lessonId: string): Promise<APIResponse> {
  return api.post('progress', { data: { lesson_id: lessonId, status: 'completed' } });
}
