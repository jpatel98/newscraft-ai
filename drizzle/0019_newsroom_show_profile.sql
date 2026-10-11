ALTER TABLE newsroom_profiles ADD COLUMN IF NOT EXISTS show_name text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD COLUMN IF NOT EXISTS air_time_local text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD COLUMN IF NOT EXISTS beats jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD COLUMN IF NOT EXISTS style_notes text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD COLUMN IF NOT EXISTS recently_covered jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE newsroom_profiles DROP CONSTRAINT IF EXISTS newsroom_profiles_air_time_local_format;
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD CONSTRAINT newsroom_profiles_air_time_local_format CHECK (air_time_local = '' OR air_time_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
--> statement-breakpoint
ALTER TABLE newsroom_profiles DROP CONSTRAINT IF EXISTS newsroom_profiles_beats_array;
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD CONSTRAINT newsroom_profiles_beats_array CHECK (jsonb_typeof(beats) = 'array' AND jsonb_array_length(beats) <= 12);
--> statement-breakpoint
ALTER TABLE newsroom_profiles DROP CONSTRAINT IF EXISTS newsroom_profiles_recently_covered_array;
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD CONSTRAINT newsroom_profiles_recently_covered_array CHECK (jsonb_typeof(recently_covered) = 'array' AND jsonb_array_length(recently_covered) <= 30);
--> statement-breakpoint
ALTER TABLE newsroom_profiles DROP CONSTRAINT IF EXISTS newsroom_profiles_style_notes_length;
--> statement-breakpoint
ALTER TABLE newsroom_profiles ADD CONSTRAINT newsroom_profiles_style_notes_length CHECK (char_length(style_notes) <= 1200);
