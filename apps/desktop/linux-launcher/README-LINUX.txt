FlowMic for Linux (portable)

To start FlowMic, double-click flowmic-desktop in this folder.

FlowMic needs a few system libraries. On Ubuntu 22.04, install them once with this command:

    sudo apt install libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libsoup-3.0-0 libayatana-appindicator3-1

If a library is missing, FlowMic shows this command instead of starting.

Prefer a regular install? Download FlowMic_{{VERSION}}_amd64.deb and run:

    sudo apt install ./FlowMic_{{VERSION}}_amd64.deb

That installs the libraries automatically and adds FlowMic to the app menu.
