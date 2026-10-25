// Real-time collaborative editing Durable Object (owned by the posts module).
export class CollabRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: unknown) {}
  async fetch(_req: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
