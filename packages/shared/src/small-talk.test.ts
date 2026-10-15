import { describe, expect, it } from 'vitest';
import { isSmallTalk } from './small-talk.js';

describe('isSmallTalk', () => {
	it.each(['yoo', 'hello', 'Hey there!', 'hi 👋', 'good morning', 'thanks!', 'thank you so much', 'lol', 'how are you?', "what's up", 'hey, how’s it going?', 'who are you', 'bye'])(
		'treats %j as small talk',
		(text) => expect(isSmallTalk(text)).toBe(true)
	);

	it.each(['', 'ok', 'sure', 'go ahead', 'yes', 'hi, what happened at city hall today?', 'hello can you check the TTC delays', 'thanks, now shorten it', 'what is up with the Gardiner closure', 'morning rundown', 'Hey Jude lyrics origin'])(
		'keeps %j on the normal path',
		(text) => expect(isSmallTalk(text)).toBe(false)
	);
});
