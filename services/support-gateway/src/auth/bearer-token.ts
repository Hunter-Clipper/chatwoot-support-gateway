export function bearerToken(req: { header(name: string): string | undefined }): string | undefined {
  const header = req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}
