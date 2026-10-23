import { test, expect } from '../../src/fixtures/base';
import { body, newApiContext } from '../../src/api/client';
import type { ApiUser } from '../../src/api/client';
import * as quiz from '../../src/api/quiz';
import type { QuizSubmitResult } from '../../src/api/quiz';
import { createPremiumUser } from '../../src/fixtures/users';
import { readAnswerKey, allWrong } from '../../src/db/quizzes';

test.describe('GET /quiz/:id', () => {
  test('never ships the answer key', async ({ userApi }) => {
    const key = await readAnswerKey();
    const payload = await body<{ questions: Record<string, unknown>[] }>(
      await quiz.getQuiz(userApi, key.quizId),
    );

    expect(payload.questions.length).toBe(key.questionCount);

    // Both spellings, because the content has used each. This is the whole
    // reason grading moved server-side: with the key in the page, the score
    // was the client's to decide.
    for (const [index, question] of payload.questions.entries()) {
      expect(question.correctIndex, `question ${index} correctIndex`).toBeUndefined();
      expect(question.correctOptionIndex, `question ${index} correctOptionIndex`).toBeUndefined();
      expect(question.options, `question ${index} options`).toBeTruthy();
      expect(question.question, `question ${index} prompt`).toBeTruthy();
    }
  });

  test('serves the prompt under `question`, whatever the row calls it', async ({ userApi }) => {
    const key = await readAnswerKey();
    const payload = await body<{ questions: Record<string, unknown>[] }>(
      await quiz.getQuiz(userApi, key.quizId),
    );

    // Normalized server-side. A database seeded with the older `questionText`
    // spelling otherwise rendered a blank question above four options, with
    // nothing in the response to explain it.
    for (const question of payload.questions) {
      expect(typeof question.question).toBe('string');
      expect(question.questionText).toBeUndefined();
    }
  });
});

test.describe('POST /quiz/submit', () => {
  test('scores a fully correct submission at 100 and awards the XP', async () => {
    const key = await readAnswerKey();
    const user = await createPremiumUser('quizpass');
    const api = await newApiContext(user.accessToken);

    try {
      const before = await body<ApiUser>(await api.get('users/me'));

      const result = await body<QuizSubmitResult>(
        await quiz.submitQuiz(api, { lesson_id: key.lessonId, answers: key.correct }),
      );

      expect(result.score).toBe(100);
      expect(result.passed).toBe(true);
      expect(result.passingScore).toBe(key.passingScore);
      expect(result.alreadyCompleted).toBe(false);
      expect(result.xpAwarded).toBeGreaterThan(0);

      const after = await body<ApiUser>(await api.get('users/me'));
      expect(after.xp).toBe(before.xp + result.xpAwarded);
    } finally {
      await api.dispose();
    }
  });

  test('scores a fully wrong submission at 0 and awards nothing', async () => {
    const key = await readAnswerKey();
    const user = await createPremiumUser('quizfail');
    const api = await newApiContext(user.accessToken);

    try {
      const before = await body<ApiUser>(await api.get('users/me'));

      const result = await body<QuizSubmitResult>(
        await quiz.submitQuiz(api, { lesson_id: key.lessonId, answers: allWrong(key) }),
      );

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
      expect(result.xpAwarded).toBe(0);

      const after = await body<ApiUser>(await api.get('users/me'));
      expect(after.xp).toBe(before.xp);
    } finally {
      await api.dispose();
    }
  });

  test('ignores a score the caller supplies', async () => {
    const key = await readAnswerKey();
    const user = await createPremiumUser('quizforge');
    const api = await newApiContext(user.accessToken);

    try {
      const before = await body<ApiUser>(await api.get('users/me'));

      // The exact payload that used to collect the XP for every lesson in the
      // app without opening one. The endpoint took the client's `score`; now
      // the field is simply not in the schema, so it is dropped.
      const result = await body<QuizSubmitResult>(
        await quiz.submitQuiz(api, {
          lesson_id: key.lessonId,
          answers: allWrong(key),
          score: 100,
          passed: true,
          xpAwarded: 9_999,
        }),
      );

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
      expect(result.xpAwarded).toBe(0);

      const after = await body<ApiUser>(await api.get('users/me'));
      expect(after.xp).toBe(before.xp);
    } finally {
      await api.dispose();
    }
  });

  test('does not pay out a second time', async () => {
    const key = await readAnswerKey();
    const user = await createPremiumUser('quiztwice');
    const api = await newApiContext(user.accessToken);

    try {
      const first = await body<QuizSubmitResult>(
        await quiz.submitQuiz(api, { lesson_id: key.lessonId, answers: key.correct }),
      );
      expect(first.xpAwarded).toBeGreaterThan(0);

      const xpAfterFirst = (await body<ApiUser>(await api.get('users/me'))).xp;

      const second = await body<QuizSubmitResult>(
        await quiz.submitQuiz(api, { lesson_id: key.lessonId, answers: key.correct }),
      );
      expect(second.score).toBe(100);
      expect(second.alreadyCompleted).toBe(true);
      // Resubmitting is allowed — a lesson can be revised — but it must not
      // farm XP. `xpAwarded` is what the UI reads, instead of guessing from
      // `alreadyCompleted`.
      expect(second.xpAwarded).toBe(0);

      expect((await body<ApiUser>(await api.get('users/me'))).xp).toBe(xpAfterFirst);
    } finally {
      await api.dispose();
    }
  });

  test('rejects a submission with no lesson', async ({ userApi }) => {
    expect((await quiz.submitQuiz(userApi, { answers: [0] })).status()).toBe(400);
  });

  test('rejects answers that are not option indexes', async ({ userApi }) => {
    const key = await readAnswerKey();
    expect(
      (await quiz.submitQuiz(userApi, { lesson_id: key.lessonId, answers: ['a'] })).status(),
    ).toBe(400);
    expect(
      (await quiz.submitQuiz(userApi, { lesson_id: key.lessonId, answers: [-1] })).status(),
    ).toBe(400);
  });

  test('a short submission is graded on what it answered', async () => {
    const key = await readAnswerKey();
    test.skip(key.questionCount < 2, 'needs a quiz with more than one question');

    const user = await createPremiumUser('quizshort');
    const api = await newApiContext(user.accessToken);

    try {
      // One right answer out of however many questions there are. A client that
      // posts a partial array must not be scored as if it had answered all of
      // them correctly.
      const result = await body<QuizSubmitResult>(
        await quiz.submitQuiz(api, { lesson_id: key.lessonId, answers: [key.correct[0]!] }),
      );
      expect(result.score).toBeLessThan(100);
      expect(result.score).toBeGreaterThan(0);
    } finally {
      await api.dispose();
    }
  });
});

test.describe('POST /progress', () => {
  test('awards lesson XP once', async () => {
    const key = await readAnswerKey();
    const user = await createPremiumUser('progress');
    const api = await newApiContext(user.accessToken);

    try {
      const before = (await body<ApiUser>(await api.get('users/me'))).xp;

      expect((await quiz.completeLesson(api, key.lessonId)).ok()).toBeTruthy();
      const afterFirst = (await body<ApiUser>(await api.get('users/me'))).xp;
      expect(afterFirst).toBeGreaterThan(before);

      // Re-calling must not farm XP; the increment is guarded on the prior
      // state, not on the request.
      expect((await quiz.completeLesson(api, key.lessonId)).ok()).toBeTruthy();
      expect((await body<ApiUser>(await api.get('users/me'))).xp).toBe(afterFirst);
    } finally {
      await api.dispose();
    }
  });
});
