export const sshConnectionMethodHelp =
  "SSH on this computer: Choose this when the ssh command, aliases or keys already work on the computer running strIDEterm. It uses that computer's OpenSSH config, keys and agent. Password and verification prompts appear in the terminal.\n\nBuilt-in SSH: Choose this to manage sign-in in strIDEterm or when OpenSSH is not installed. It supports passwords, agents and keys imported into the app, with prompts shown here. It does not read OpenSSH config or use SSH certificates.\n\nSSH in WSL (Windows only): Choose this when your SSH setup and keys live inside a Linux WSL distribution. It uses that distribution's OpenSSH, config, keys and agent. Windows SSH files and paths do not apply.";

export const sshDefaultMethodHelp = `${sshConnectionMethodHelp}\n\nUse app default to apply the method selected in Settings to this host or quick connection. A host with its own method keeps that choice. Changes affect future connections, not terminals already open.`;

export const sshGlobalDefaultMethodHelp = `${sshConnectionMethodHelp}\n\nThis setting is used by hosts and quick connections set to “Use app default”. Hosts with their own method keep that choice. Changes affect future connections, not terminals already open.`;

export const sshAuthenticationHelp =
  "SSH agent uses keys already unlocked by an agent. Saved key uses a private key imported into strIDEterm; its matching public key must be authorized on the server. Password / verification code asks while connecting and is not saved. A key passphrase unlocks your private key; it is different from your password for the server account. Multi-step sign-in may ask for more than one verification response.";
