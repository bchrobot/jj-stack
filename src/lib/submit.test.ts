import {
  executeSubmissionPlan,
  type SubmissionPlan,
  type GitHubConfig,
  type PullRequest,
} from "./submit.js";
import type { Bookmark } from "./jjTypes.js";
import type { JjFunctions } from "./jjUtils.js";
import assert from "assert/strict";

suite("submit operations", () => {
  test("interleaves push and base update operations", async () => {
    console.log(
      "\n=== Testing interleaved push and base update operations ===",
    );

    // This test verifies that push and base update operations are interleaved
    // to prevent indirect merge conditions
    // Bug: pushing all branches first, then updating all bases creates a window
    //      where PRs can have new commits but old bases, triggering indirect merges

    const operationLog: string[] = [];

    const mockGitHubConfig: GitHubConfig = {
      owner: "test",
      repo: "repo",
      octokit: {
        rest: {
          pulls: {
            update: async ({
              pull_number,
              base,
            }: {
              pull_number: number;
              base: string;
            }) => {
              operationLog.push(`UPDATE_BASE(PR${pull_number}, ${base})`);
              return {
                data: {
                  number: pull_number,
                  html_url: `https://github.com/test/repo/pull/${pull_number}`,
                  title: "Test PR",
                  base: { ref: base, sha: "abc" },
                  head: { ref: "test", sha: "def" },
                } as PullRequest,
              };
            },
          },
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async () => ({ data: { id: 1 } }),
          },
        },
      } as any,
    };

    const mockJj: JjFunctions = {
      gitFetch: () => Promise.resolve(),
      getMyBookmarks: () => Promise.resolve([]),
      getBranchChangesPaginated: () => Promise.resolve([]),
      getGitRemoteList: () => Promise.resolve([]),
      getDefaultBranch: () => Promise.resolve("main"),
      pushBookmark: async (name: string) => {
        operationLog.push(`PUSH(${name})`);
      },
    };

    const bookmarkB: Bookmark = {
      name: "bookmark-b",
      commitId: "commit_b",
      changeId: "change_b",
      hasRemote: false,
      isSynced: false,
    };

    const bookmarkC: Bookmark = {
      name: "bookmark-c",
      commitId: "commit_c",
      changeId: "change_c",
      hasRemote: false,
      isSynced: false,
    };

    const bookmarkA: Bookmark = {
      name: "bookmark-a",
      commitId: "commit_a",
      changeId: "change_a",
      hasRemote: false,
      isSynced: false,
    };

    const plan: SubmissionPlan = {
      targetBookmark: "bookmark-a",
      bookmarksToSubmit: [bookmarkB, bookmarkC, bookmarkA],
      bookmarksNeedingPush: [bookmarkB, bookmarkC, bookmarkA],
      bookmarksNeedingPR: [], // PRs already exist in reorder stack scenario
      bookmarksNeedingPRBaseUpdate: [
        {
          bookmark: bookmarkB,
          currentBaseBranch: "old-base-b",
          expectedBaseBranchOptions: ["main"],
          pr: {
            number: 2,
            html_url: "https://github.com/test/repo/pull/2",
            title: "B",
            base: { ref: "old-base-b", sha: "abc" },
            head: { ref: "bookmark-b", sha: "def" },
          } as PullRequest,
        },
        {
          bookmark: bookmarkC,
          currentBaseBranch: "old-base-c",
          expectedBaseBranchOptions: ["bookmark-b"],
          pr: {
            number: 3,
            html_url: "https://github.com/test/repo/pull/3",
            title: "C",
            base: { ref: "old-base-c", sha: "ghi" },
            head: { ref: "bookmark-c", sha: "jkl" },
          } as PullRequest,
        },
        {
          bookmark: bookmarkA,
          currentBaseBranch: "old-base-a",
          expectedBaseBranchOptions: ["bookmark-c"],
          pr: {
            number: 1,
            html_url: "https://github.com/test/repo/pull/1",
            title: "A",
            base: { ref: "old-base-a", sha: "mno" },
            head: { ref: "bookmark-a", sha: "pqr" },
          } as PullRequest,
        },
      ],
      repoInfo: { owner: "test", repo: "repo" },
      existingPRs: new Map(),
      remoteName: "origin",
    };

    await executeSubmissionPlan(mockJj, plan, mockGitHubConfig);

    console.log("Operation sequence:", operationLog);

    // Verify interleaved operations: each push should be followed by its base update
    // Expected: PUSH(B), UPDATE_BASE(PR2), PUSH(C), UPDATE_BASE(PR3), PUSH(A), UPDATE_BASE(PR1)

    // Find indices of operations
    const pushBIdx = operationLog.indexOf("PUSH(bookmark-b)");
    const updateBIdx = operationLog.indexOf("UPDATE_BASE(PR2, main)");
    const pushCIdx = operationLog.indexOf("PUSH(bookmark-c)");
    const updateCIdx = operationLog.indexOf("UPDATE_BASE(PR3, bookmark-b)");
    const pushAIdx = operationLog.indexOf("PUSH(bookmark-a)");
    const updateAIdx = operationLog.indexOf("UPDATE_BASE(PR1, bookmark-c)");

    // Verify all operations occurred
    assert.ok(pushBIdx >= 0, "Expected PUSH(bookmark-b) to occur");
    assert.ok(updateBIdx >= 0, "Expected UPDATE_BASE(PR2) to occur");
    assert.ok(pushCIdx >= 0, "Expected PUSH(bookmark-c) to occur");
    assert.ok(updateCIdx >= 0, "Expected UPDATE_BASE(PR3) to occur");
    assert.ok(pushAIdx >= 0, "Expected PUSH(bookmark-a) to occur");
    assert.ok(updateAIdx >= 0, "Expected UPDATE_BASE(PR1) to occur");

    // Critical assertions: verify interleaved order
    assert.ok(
      pushBIdx < updateBIdx,
      `Expected PUSH(bookmark-b) before UPDATE_BASE(PR2), but got indices ${pushBIdx}, ${updateBIdx}. ` +
        `Bug: if all pushes happen first, indirect merge conditions can occur.`,
    );

    assert.ok(
      updateBIdx < pushCIdx,
      `Expected UPDATE_BASE(PR2) before PUSH(bookmark-c), got indices ${updateBIdx}, ${pushCIdx}. ` +
        `Operations should be interleaved, not batched.`,
    );

    assert.ok(
      pushCIdx < updateCIdx,
      `Expected PUSH(bookmark-c) before UPDATE_BASE(PR3), but got indices ${pushCIdx}, ${updateCIdx}`,
    );

    assert.ok(
      updateCIdx < pushAIdx,
      `Expected UPDATE_BASE(PR3) before PUSH(bookmark-a), got indices ${updateCIdx}, ${pushAIdx}`,
    );

    assert.ok(
      pushAIdx < updateAIdx,
      `Expected PUSH(bookmark-a) before UPDATE_BASE(PR1), but got indices ${pushAIdx}, ${updateAIdx}`,
    );

    // Verify operations are in strict interleaved sequence (no batching)
    const expectedPattern = [
      "PUSH(bookmark-b)",
      "UPDATE_BASE(PR2, main)",
      "PUSH(bookmark-c)",
      "UPDATE_BASE(PR3, bookmark-b)",
      "PUSH(bookmark-a)",
      "UPDATE_BASE(PR1, bookmark-c)",
    ];

    // Filter operation log to only push/update operations
    const relevantOps = operationLog.filter(
      (op) => op.startsWith("PUSH(") || op.startsWith("UPDATE_BASE("),
    );

    assert.deepStrictEqual(
      relevantOps,
      expectedPattern,
      `Expected strict interleaved pattern, but got: ${JSON.stringify(relevantOps)}. ` +
        `This ensures no indirect merge conditions can occur.`,
    );

    console.log("✓ Push and base update operations are correctly interleaved");
  });
});
