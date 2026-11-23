import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalConversationPair,
  countUnreadByConversation,
  evaluateMessagingEligibility,
  isAttachmentPathAuthorized,
  mergeOrderedMessages,
  validateAttachmentFileMeta,
  validateMessageInput,
  validateStartConversation,
} from "../src/lib/messages/validation.ts";

const USER_A = "17d414ce-8349-4dc2-bccd-94d9bd0ebc52";
const USER_B = "d3b398d8-9103-4bc2-84d3-6e0101b7659a";
const CONV_ID = "53c1fcba-804e-4743-a429-7c4c57ca8d29";
const OTHER_CONV_ID = "99999999-804e-4743-a429-7c4c57ca8d29";
const LISTING_ID = "2990db4c-11d6-4ec9-b4dd-5209a80ed74f";

function makeEligibility(role = "student", userId = USER_A) {
  return evaluateMessagingEligibility({
    isAuthenticated: true,
    isEmailVerified: true,
    isActiveMember: true,
    profile: {
      id: userId,
      email: "member@iluv.ums.edu.my",
      university_role: role,
      status: "active",
      restriction_reason: null,
      full_name: "Member",
      display_name: "Member",
      faculty: "FKI",
      bio: null,
      avatar_url: null,
      created_at: "2026-01-01T00:00:00Z",
    },
  });
}

test("evaluateMessagingEligibility allows Student/Staff and blocks guests and dedicated admin roles", () => {
  assert.equal(makeEligibility("student").eligible, true);
  assert.equal(makeEligibility("staff").eligible, true);
  assert.equal(makeEligibility("admin").eligible, false);

  const guest = evaluateMessagingEligibility({
    isAuthenticated: false,
    isEmailVerified: false,
    isActiveMember: false,
    profile: null,
  });
  assert.equal(guest.eligible, false);
  assert.equal(guest.code, "unauthenticated");
});

test("canonicalConversationPair prevents duplicate threads and blocks self-messaging", () => {
  const pair1 = canonicalConversationPair(USER_A, USER_B);
  const pair2 = canonicalConversationPair(USER_B, USER_A);
  assert.deepEqual(pair1, pair2);
  assert.equal(pair1?.memberA, USER_A);
  assert.equal(pair1?.memberB, USER_B);

  // Self-messaging rejected
  assert.equal(canonicalConversationPair(USER_A, USER_A), null);

  const selfCheck = validateStartConversation({
    eligibility: makeEligibility("student", USER_A),
    peerUserId: USER_A,
    listingId: LISTING_ID,
    isBlocked: false,
  });
  assert.equal(selfCheck.ok, false);

  // Blocked member rejected
  const blockedCheck = validateStartConversation({
    eligibility: makeEligibility("student", USER_A),
    peerUserId: USER_B,
    listingId: LISTING_ID,
    isBlocked: true,
  });
  assert.equal(blockedCheck.ok, false);
});

test("attachment authorization and file validation block cross-conversation paths, traversal, and oversized/disallowed files", () => {
  assert.equal(
    isAttachmentPathAuthorized(CONV_ID, `${CONV_ID}/${USER_A}/photo.png`),
    true
  );
  assert.equal(
    isAttachmentPathAuthorized(CONV_ID, `${OTHER_CONV_ID}/${USER_A}/photo.png`),
    false
  );
  assert.equal(
    isAttachmentPathAuthorized(CONV_ID, `${CONV_ID}/../other/secret.pdf`),
    false
  );
  assert.equal(
    isAttachmentPathAuthorized(CONV_ID, `/${CONV_ID}/photo.png`),
    false
  );

  assert.equal(
    validateAttachmentFileMeta({
      name: "receipt.pdf",
      type: "application/pdf",
      size: 1024 * 500,
    }).ok,
    true
  );
  assert.equal(
    validateAttachmentFileMeta({
      name: "script.exe",
      type: "application/x-msdownload",
      size: 1024,
    }).ok,
    false
  );
  assert.equal(
    validateAttachmentFileMeta({
      name: "huge.png",
      type: "image/png",
      size: 6 * 1024 * 1024,
    }).ok,
    false
  );
});

test("validateMessageInput enforces participant isolation, block rules, and attachment-only or text messages", () => {
  const eligibility = makeEligibility("student", USER_A);

  // Non-participant rejected
  assert.equal(
    validateMessageInput({
      eligibility,
      conversationId: CONV_ID,
      isParticipant: false,
      isBlocked: false,
      body: "Hello",
    }).ok,
    false
  );

  // Blocked rejected
  assert.equal(
    validateMessageInput({
      eligibility,
      conversationId: CONV_ID,
      isParticipant: true,
      isBlocked: true,
      body: "Hello",
    }).ok,
    false
  );

  // Empty body + no attachments rejected
  assert.equal(
    validateMessageInput({
      eligibility,
      conversationId: CONV_ID,
      isParticipant: true,
      isBlocked: false,
      body: "   ",
      attachmentPaths: [],
    }).ok,
    false
  );

  // Attachment-only message accepted with authorized path
  const okAttach = validateMessageInput({
    eligibility,
    conversationId: CONV_ID,
    isParticipant: true,
    isBlocked: false,
    body: "",
    attachmentPaths: [`${CONV_ID}/${USER_A}/pic.jpg`],
    listingId: LISTING_ID,
  });
  assert.equal(okAttach.ok, true);
});

test("mergeOrderedMessages deduplicates Realtime echoes and preserves chronological order", () => {
  const merged = mergeOrderedMessages(
    [
      { id: "m2", createdAt: "2026-11-22T19:36:30.000Z" },
      { id: "m1", createdAt: "2026-11-22T19:36:11.000Z" },
    ],
    [
      { id: "m2", createdAt: "2026-11-22T19:36:30.000Z" }, // duplicate echo
      { id: "m3", createdAt: "2026-11-22T19:36:41.000Z" },
    ]
  );

  assert.deepEqual(
    merged.map((m) => m.id),
    ["m1", "m2", "m3"]
  );
});

test("countUnreadByConversation counts only unread message notifications per conversation", () => {
  const counts = countUnreadByConversation([
    {
      id: "n1",
      kind: "new_message",
      href: `/messages?c=${CONV_ID}`,
      read_at: null,
    },
    {
      id: "n2",
      kind: "message",
      href: `/messages?c=${CONV_ID}`,
      read_at: null,
    },
    {
      id: "n3",
      kind: "new_message",
      href: `/messages?c=${CONV_ID}`,
      read_at: "2026-11-22T20:00:00Z", // already read
    },
    {
      id: "n4",
      kind: "order_completed",
      href: `/orders/${CONV_ID}`,
      read_at: null, // non-message notification
    },
  ]);

  assert.equal(counts.totalUnread, 2);
  assert.equal(counts.byConversation[CONV_ID], 2);
});
