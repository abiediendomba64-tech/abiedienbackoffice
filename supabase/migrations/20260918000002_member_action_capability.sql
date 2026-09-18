-- Canonical member management capability used by backoffice-api-v3.
INSERT INTO public.backoffice_capabilities (code, description, category)
VALUES ('member.manage', 'Approve, suspend, and manage member access state', 'member')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.backoffice_role_capabilities (role, capability_code)
VALUES ('admin', 'member.manage'), ('super_admin', 'member.manage'), ('root', 'member.manage')
ON CONFLICT (role, capability_code) DO NOTHING;
