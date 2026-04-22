import assert from "node:assert/strict";
import test from "node:test";

import { getOnboardingContentForChannelSlug } from "../../src/components/onboarding/workspace-onboarding";

test("getOnboardingContentForChannelSlug returns experts content", () => {
  const content = getOnboardingContentForChannelSlug("experts");

  assert.equal(content.title, "Find strong voices fast");
  assert.equal(content.prompts.length, 3);
  assert.equal(content.prompts[0].id, "experts-first");
});

test("getOnboardingContentForChannelSlug returns digest content", () => {
  const content = getOnboardingContentForChannelSlug("digest");

  assert.equal(content.title, "Turn the latest coverage into a briefing");
  assert.equal(content.prompts[0].prompt, "/digest");
});

test("getOnboardingContentForChannelSlug falls back to default", () => {
  const content = getOnboardingContentForChannelSlug("random-channel");

  assert.equal(content.title, "Use channel commands to get started");
  assert.equal(content.prompts[0].prompt, "/help");
});
