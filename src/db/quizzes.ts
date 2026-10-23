import { pool } from './pool';

export interface QuizAnswerKey {
  quizId: string;
  lessonId: string;
  passingScore: number;
  xpReward: number;
  /** The correct option index for each question, in order. */
  correct: number[];
  questionCount: number;
}

/**
 * Reads the answer key straight out of the seeded content.
 *
 * This is the one place the suite deliberately looks behind the API, and it is
 * the point of the exercise: `correctIndex` is stripped from every response, so
 * a test that wanted to prove a fully-correct submission scores 100 has no way
 * to construct one from what the client can see. Which is exactly the property
 * worth proving — the grading moved server-side because the answer key used to
 * ship with the questions, and `{ score: 100 }` collected the XP for every
 * lesson without opening one.
 *
 * So: the key comes from the database, the submission goes through the API, and
 * the score is the API's own. Nothing about the grading is reimplemented here.
 */
export async function readAnswerKey(): Promise<QuizAnswerKey> {
  const { rows } = await pool.query<{
    id: string;
    lesson_id: string;
    passing_score: number;
    xp_reward: number;
    questions: unknown;
  }>(
    `SELECT id, lesson_id, passing_score, xp_reward, questions
       FROM quizzes
      WHERE jsonb_array_length(questions::jsonb) > 0
      ORDER BY id
      LIMIT 1`,
  );

  const row = rows[0];
  if (!row) {
    throw new Error('No quiz with questions in the test database — run `npm run db:seed`');
  }

  const questions = row.questions as { correctIndex?: number; correctOptionIndex?: number }[];
  const correct = questions.map((question, index) => {
    const answer = question.correctIndex ?? question.correctOptionIndex;
    if (typeof answer !== 'number') {
      throw new Error(`Seeded quiz question ${index} has no answer key`);
    }
    return answer;
  });

  return {
    quizId: row.id,
    lessonId: row.lesson_id,
    passingScore: row.passing_score,
    xpReward: row.xp_reward,
    correct,
    questionCount: questions.length,
  };
}

/** An answer for every question that is never the right one. */
export function allWrong(key: QuizAnswerKey): number[] {
  // Options run to at least four everywhere in the seed, so (correct + 1) % 4
  // is always both a valid index and the wrong one.
  return key.correct.map((answer) => (answer + 1) % 4);
}
