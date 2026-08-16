-- Draggable plano hotspot positions, editable by admins, readable by everyone.
--
-- Both planos (index.html public guide + student.html) render from their
-- hardcoded default positions first, then non-blockingly overlay any rows
-- stored here. The admin "Editar plano" tool on the guide upserts rows.
--
-- space_key = the space's clean name (e.g. 'Cora', 'Caelum', 'The WHY').
-- x, y are fractions of the plano's rendered width/height, in [0, 1].
--
-- Idempotent: safe to re-run. Run manually in the Supabase SQL Editor.

BEGIN;

CREATE TABLE IF NOT EXISTS public.space_positions (
  space_key  text PRIMARY KEY,
  x          numeric NOT NULL CHECK (x BETWEEN 0 AND 1),
  y          numeric NOT NULL CHECK (y BETWEEN 0 AND 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.space_positions ENABLE ROW LEVEL SECURITY;

-- Public read: the guide is a public page (anon) and the app is authenticated.
DROP POLICY IF EXISTS "space_positions readable by everyone" ON public.space_positions;
CREATE POLICY "space_positions readable by everyone"
  ON public.space_positions
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Only admins may create positions.
DROP POLICY IF EXISTS "space_positions insert by admins" ON public.space_positions;
CREATE POLICY "space_positions insert by admins"
  ON public.space_positions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'::public.role
    )
  );

-- Only admins may move existing positions.
DROP POLICY IF EXISTS "space_positions update by admins" ON public.space_positions;
CREATE POLICY "space_positions update by admins"
  ON public.space_positions
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'::public.role
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'::public.role
    )
  );

COMMIT;
