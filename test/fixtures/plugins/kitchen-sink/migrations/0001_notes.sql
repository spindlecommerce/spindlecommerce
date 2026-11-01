-- Plain SQL, split at semicolons outside strings, comments and dollar-quoted bodies.
CREATE TABLE "kitchen_sink_notes" (
  "id" serial PRIMARY KEY,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
/* The first note; its semicolon is data. */
INSERT INTO "kitchen_sink_notes" ("body") VALUES ('first; note');
CREATE FUNCTION kitchen_sink_shout(value text) RETURNS text AS $$ SELECT upper(value) || '!'; $$ LANGUAGE sql;
