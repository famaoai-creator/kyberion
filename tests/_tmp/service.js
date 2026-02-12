function handleRequest(req) {
  validate(req);
  const data = fetchData(req.id);
  return formatResponse(data);
}

function validate(req) {
  checkAuth(req.token);
}