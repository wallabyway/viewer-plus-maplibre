// CloudFront Function: aps-cors-proxy (viewer-response)
// Adds CORS headers to responses from aps-extensions.autodesk.io
// so the browser allows cross-origin fetches from our GitHub Pages site.

function handler(event) {
  var response = event.response;
  var headers = response.headers;

  headers['access-control-allow-origin'] = { value: '*' };
  headers['access-control-allow-methods'] = { value: 'GET, OPTIONS' };
  headers['access-control-allow-headers'] = { value: 'Content-Type' };

  return response;
}
