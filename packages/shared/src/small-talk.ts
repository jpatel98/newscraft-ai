// Greetings, thanks, farewells and "who are you" chat. These get a short plain
// reply with no research run. Confirmations ("ok", "sure", "go ahead") are left
// out on purpose: they can answer a question and should keep the normal path.
const GREETING = String.raw`(?:h+i+|h+e+y+|hello+|hiya|howdy|yo+|sup|wass?up|what'?s up|good (?:morning|afternoon|evening|night)|morning|evening|gm|greetings)`;
const THANKS = String.raw`(?:thanks?(?: (?:a lot|so much|again))?|thank you(?: (?:so much|again))?|thx|ty|cheers|appreciate it)`;
const FAREWELL = String.raw`(?:bye|goodbye|good ?night|see (?:ya|you)(?: later)?|later|cya|ttyl)`;
const LAUGH = String.raw`(?:lol|lmao|haha+|hehe+)`;
const ABOUT = String.raw`(?:how are you(?: doing)?|how'?s it going|how are things|who are you|what are you|what can you do|what do you do)`;
const ADDRESS = String.raw`(?: (?:there|all|everyone|friend|buddy|man|dude|newscraft(?: ai)?|bot))?`;
const PHRASE = `(?:${GREETING}|${THANKS}|${FAREWELL}|${LAUGH}|${ABOUT})${ADDRESS}`;
const SMALL_TALK = new RegExp(`^${PHRASE}(?: ${PHRASE}){0,3}$`, 'i');

export function isSmallTalk(text: string): boolean {
	const normalized = text
		.normalize('NFKC')
		.replace(/[’‘]/g, "'")
		.replace(/[^\p{L}\p{N}' ]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
	return normalized.length > 0 && normalized.length <= 60 && SMALL_TALK.test(normalized);
}
