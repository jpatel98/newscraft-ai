import { normalizeEvidence } from './evidence.js';
import { NEWSROOM_TOOL_NAMES } from './router.js';
import { evidenceOutputSchema, type NewsroomTool } from './tools.js';
import { NEWSCRAFT_USER_AGENT } from '../tools/sources.js';

const CITY_WEATHER_ENDPOINT =
	'https://api.weather.gc.ca/collections/citypageweather-realtime/items';
const WEATHER_TIMEOUT_MS = 10_000;
const DEFAULT_WEATHER_LOCATION = 'Toronto';

interface LocalizedValue<T> {
	en?: T;
	fr?: T;
}

interface WeatherCurrentConditions {
	timestamp?: LocalizedValue<string>;
	condition?: LocalizedValue<string>;
	temperature?: {
		value?: LocalizedValue<number>;
	};
	relativeHumidity?: {
		value?: LocalizedValue<number>;
	};
	wind?: {
		speed?: {
			value?: LocalizedValue<number | string>;
		};
		gust?: {
			value?: LocalizedValue<number | string>;
		};
		direction?: {
			value?: LocalizedValue<string>;
		};
	};
}

interface WeatherFeature {
	properties?: {
		lastUpdated?: string;
		identifier?: string;
		name?: LocalizedValue<string>;
		region?: LocalizedValue<string>;
		url?: LocalizedValue<string>;
		currentConditions?: WeatherCurrentConditions;
		forecastGroup?: {
			timestamp?: LocalizedValue<string>;
			forecasts?: Array<{
				period?: {
					textForecastName?: LocalizedValue<string>;
				};
				textSummary?: LocalizedValue<string>;
			}>;
		};
	};
}

interface WeatherFeatureCollection {
	features?: WeatherFeature[];
}

export function weatherLookupTool(): NewsroomTool<{ query: string }> {
	return {
		name: NEWSROOM_TOOL_NAMES.weatherLookup,
		description: 'Read current Canadian conditions and forecasts from Environment Canada structured data.',
		when_to_use: 'Use for ordinary current weather, temperature, rain, snow, and short forecast questions about Canadian locations.',
		category: 'custom',
		input_schema: {
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query']
		},
		output_schema: evidenceOutputSchema,
		async run(input, context) {
			const location =
				weatherLocationFromQuery(input.query) ||
				weatherLocationFromHomeMarket(context.newsroomContext?.homeMarket) ||
				DEFAULT_WEATHER_LOCATION;
			const url = new URL(CITY_WEATHER_ENDPOINT);
			url.searchParams.set('f', 'json');
			url.searchParams.set('limit', '8');
			url.searchParams.set('name.en', location);

			let response: Response;
			try {
				response = await fetch(url, {
					headers: {
						accept: 'application/geo+json, application/json',
						'user-agent': NEWSCRAFT_USER_AGENT
					},
					signal: boundedWeatherSignal(context.signal)
				});
			} catch {
				return {
					status: 'unavailable',
					limitations: ['Environment Canada weather data is temporarily unavailable.']
				};
			}
			if (!response.ok) {
				return {
					status: 'unavailable',
					limitations: [`Environment Canada weather data returned HTTP ${response.status}.`]
				};
			}

			const payload = (await response.json().catch(() => null)) as WeatherFeatureCollection | null;
			const feature = selectWeatherFeature(payload?.features || [], location);
			if (!feature?.properties) {
				return {
					status: 'unavailable',
					limitations: [`No Environment Canada city forecast matched ${location}.`]
				};
			}

			const result = weatherAnswer(feature, input.query);
			if (!result) {
				return {
					status: 'unavailable',
					limitations: [`Environment Canada did not return current conditions or a forecast for ${location}.`]
				};
			}

			const properties = feature.properties;
			const place = properties.name?.en || location;
			const sourceUrl =
				properties.url?.en ||
				(properties.identifier
					? `${CITY_WEATHER_ENDPOINT}/${encodeURIComponent(properties.identifier)}?f=html`
					: CITY_WEATHER_ENDPOINT);
			const publishedAt =
				properties.currentConditions?.timestamp?.en ||
				properties.forecastGroup?.timestamp?.en ||
				properties.lastUpdated ||
				null;
			const evidenceText = result.answer
				.replace(/\*\*/g, '')
				.replace(/\s*\[1\]\s*$/, '')
				.replace(/\s+/g, ' ')
				.trim();

			return {
				status: 'ok',
				answer: result.answer,
				evidence: [
					normalizeEvidence({
						source_name: 'Environment and Climate Change Canada',
						source_url: sourceUrl,
						accessed_at: new Date().toISOString(),
						tool_used: NEWSROOM_TOOL_NAMES.weatherLookup,
						title: `${place} current weather and forecast`,
						published_at: publishedAt,
						extracted_text: evidenceText,
						summary: evidenceText,
						confidence: 0.98,
						limitations: ['Conditions and forecasts can change as Environment Canada updates its observations and models.'],
						source_kind: 'official',
						citation_number: 1
					})
				]
			};
		}
	};
}

export function weatherLocationFromQuery(query: string): string | null {
	const value = query
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/[?!]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!value) return null;

	const candidates = [
		value.match(/\b(?:weather|forecast|temperature|conditions?)\s+(?:in|for|at|near)\s+(.+)$/i)?.[1],
		value.match(/\b(?:is it|will it|chance of)\s+(?:rain(?:ing)?|snow(?:ing)?)\b[\s\S]*?\b(?:in|for|at|near)\s+(.+)$/i)?.[1],
		value.match(/\b(?:in|for|at|near)\s+(.+?)(?=\s+\b(?:today|tonight|tomorrow|right now|now)\b|$)/i)?.[1],
		value.match(/^(?:what(?:'s| is)|how(?:'s| is)|give me|show me|check)?\s*(.+?)\s+(?:weather|forecast|temperature|conditions?)\b/i)?.[1],
		value.match(/^(?:weather|forecast|temperature|conditions?)\s+(.+)$/i)?.[1]
	].filter((candidate): candidate is string => Boolean(candidate?.trim()));

	const cleaned = cleanWeatherLocation(candidates[0] || '');
	return cleaned || null;
}

function weatherLocationFromHomeMarket(homeMarket: string | undefined): string | null {
	if (!homeMarket?.trim()) return null;
	return cleanWeatherLocation(homeMarket);
}

function cleanWeatherLocation(value: string): string {
	const withoutTiming = value
		.replace(/\b(?:today|tonight|tomorrow|right now|now|this morning|this afternoon|this evening)\b.*$/i, '')
		.replace(/^(?:the|current|live)\s+/i, '')
		.replace(/^(?:what(?:'s| is)|how(?:'s| is))\s+/i, '')
		.replace(/\b(?:weather|forecast|temperature|conditions?)\b.*$/i, '')
		.replace(/\s+(?:canada|ontario|quebec|québec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland(?: and labrador)?|prince edward island|yukon|nunavut|northwest territories)\s*$/i, '')
		.split(',')[0]
		.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!withoutTiming || withoutTiming.length > 80) return '';
	return withoutTiming;
}

function selectWeatherFeature(features: WeatherFeature[], location: string): WeatherFeature | null {
	const wanted = normalizeLocation(location);
	const named = features.filter((feature) => Boolean(feature.properties?.name?.en));
	return (
		named.find((feature) => normalizeLocation(feature.properties?.name?.en || '') === wanted) ||
		named.find((feature) => normalizeLocation(feature.properties?.name?.en || '').startsWith(wanted)) ||
		named[0] ||
		null
	);
}

function normalizeLocation(value: string): string {
	return value
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function weatherAnswer(feature: WeatherFeature, query: string): { answer: string } | null {
	const properties = feature.properties;
	if (!properties) return null;
	const place = properties.name?.en || 'This location';
	const current = currentConditionsSentence(properties.currentConditions);
	const forecast = selectForecast(properties.forecastGroup?.forecasts || [], query);
	const forecastSentence = forecast?.textSummary?.en
		? `**${forecast.period?.textForecastName?.en || 'Forecast'}:** ${withCelsius(forecast.textSummary.en)}`
		: '';
	if (!current && !forecastSentence) return null;
	const lines = [
		current ? `**${place} weather:** ${current}` : `**${place} forecast:**`,
		forecastSentence
	].filter(Boolean);
	return { answer: `${lines.join('\n\n')} [1]` };
}

function currentConditionsSentence(current: WeatherCurrentConditions | undefined): string {
	if (!current) return '';
	const temperature = finiteNumber(current.temperature?.value?.en);
	const condition = current.condition?.en?.trim();
	const primary = [
		temperature === null ? '' : `${compactNumber(temperature)}°C`,
		condition ? condition.toLowerCase() : ''
	].filter(Boolean);
	const details: string[] = [];
	const humidity = finiteNumber(current.relativeHumidity?.value?.en);
	if (humidity !== null) details.push(`humidity ${compactNumber(humidity)}%`);
	const windSpeed = current.wind?.speed?.value?.en;
	const windDirection = current.wind?.direction?.value?.en?.trim();
	if (windSpeed !== undefined && windSpeed !== null && String(windSpeed).trim()) {
		const wind = `${windDirection ? `${windDirection} ` : ''}wind ${windSpeed} km/h`;
		const gust = current.wind?.gust?.value?.en;
		details.push(gust && Number(gust) > 0 ? `${wind}, gusting to ${gust} km/h` : wind);
	}
	if (!primary.length && !details.length) return '';
	const first = primary.length ? `${primary.join(' and ')}.` : '';
	const second = details.length ? `${capitalize(details.join('; '))}.` : '';
	return [first, second].filter(Boolean).join(' ');
}

function selectForecast(
	forecasts: NonNullable<NonNullable<WeatherFeature['properties']>['forecastGroup']>['forecasts'],
	query: string
) {
	if (!forecasts?.length) return null;
	if (/\btonight\b/i.test(query)) {
		return forecasts.find((forecast) => /\b(?:tonight|night)\b/i.test(forecast.period?.textForecastName?.en || '')) || forecasts[0];
	}
	if (/\btomorrow\b/i.test(query)) {
		const explicitlyTomorrow = forecasts.find((forecast) =>
			/\btomorrow\b/i.test(forecast.period?.textForecastName?.en || '')
		);
		if (explicitlyTomorrow) return explicitlyTomorrow;
		const daytime = forecasts.filter(
			(forecast) => !/\b(?:tonight|night)\b/i.test(forecast.period?.textForecastName?.en || '')
		);
		return /\btoday\b/i.test(daytime[0]?.period?.textForecastName?.en || '')
			? daytime[1] || daytime[0] || forecasts[0]
			: daytime[0] || forecasts[0];
	}
	return forecasts[0];
}

function withCelsius(value: string): string {
	return value
		.replace(/\b(High|Low) (-?\d+(?:\.\d+)?)\b/g, '$1 $2°C')
		.replace(/\s+/g, ' ')
		.trim();
}

function finiteNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function compactNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function capitalize(value: string): string {
	return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function boundedWeatherSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(WEATHER_TIMEOUT_MS);
	if (signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
	return timeout;
}
