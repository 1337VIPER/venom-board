# Security

## Reporting a problem

If you find a security problem in Venom Board (the apps, venomboard.com, or the server in `server/`), please
report it privately rather than in a public issue: email **support@venomboard.com** with what you found and how
to reproduce it. You'll get an answer, and a fix goes to venomboard.com and to this repository together.

Please don't test against other people's accounts or data on venomboard.com, and don't run anything that
degrades the service for others. Your own account and team, or a server you run yourself, are fine.

## Supported versions

Fixes go into the latest release of the desktop app and the latest `server/` on the main branch. If you run your
own server, update it when a new version is out.

## Notes for contributors

The server builds templates by running part of the app's `index.html` (the template code) inside Node, so changes
to that code are reviewed with the same care as changes to the server itself.
