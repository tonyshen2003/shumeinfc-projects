export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/member") {
      return Response.json({ found: true, member: { name: "test", readableCode: "TEST" } });
    }
    return env.ASSETS.fetch(request);
  },
};
