/*
 * NR-107 - the file a Linux user double-clicks in the portable bundle.
 *
 * WHY THIS EXISTS [owner report 2026-09-25, stock Ubuntu 22.04 desktop]:
 *   the portable zip used to put the Tauri binary itself under this name. That
 *   binary needs libwebkit2gtk-4.1 / libjavascriptcoregtk-4.1 / libsoup-3.0, a
 *   stock 22.04 desktop has none of them, and when the dynamic loader refuses a
 *   program started from the Files app nothing is shown anywhere: double-click
 *   and right-click Run both did nothing.
 *
 * WHY A BINARY AND NOT A SHELL SCRIPT OR A .desktop FILE:
 *   Nautilus on 22.04 opens a shell script in a text editor on double-click, and
 *   it does not launch an untrusted .desktop file. An ELF executable is the one
 *   thing it runs directly (the owner's report shows it tried to). So this is an
 *   ELF that links against libc only - the release gate
 *   (scripts/linux-runtime-deps-gate.mjs, LAUNCHER_ALLOWED_NEEDED) refuses any
 *   other DT_NEEDED entry - checks the libraries with dlopen(), and then execs
 *   the real binary with the same argv. With the libraries present the only
 *   difference is one extra exec.
 *
 * WHAT dlopen() PROVES: the same thing the loader would find, including every
 * library the checked one needs in turn (a present libwebkit2gtk with a missing
 * libsoup still fails here, as it would at start).
 *
 * The check list below must cover every DT_NEEDED library that a stock 22.04
 * desktop lacks; the release gate reads THIS BINARY's bytes for each soname and
 * its install line, against scripts/linux-runtime-libs.mjs.
 *
 * Diagnostics: FLOWMIC_LAUNCHER_TRACE=1 prints which notifier was used.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* The real Tauri binary, in the same directory as this launcher. Kept in the
 * same directory because the app finds its bundled node and resources relative
 * to its own executable (sidecar/node_runtime.rs bundled_node_beside). Hidden,
 * so the Files app shows one thing to double-click. Must equal
 * LINUX_PORTABLE_REAL_EXE in scripts/linux-portable-modes.mjs (the release gate
 * checks this binary carries it). */
#define REAL_BINARY_NAME ".flowmic-desktop-bin"

/* ------------------------------------------------------------------------ *
 * USER-VISIBLE COPY (D-47). Every sentence this launcher can show a user is  *
 * in this block and nowhere else. The install command is not copy: it must  *
 * stay exact.                                                                *
 * ------------------------------------------------------------------------ */
#define COPY_TITLE "FlowMic cannot start"
#define COPY_MISSING_LEAD "FlowMic needs a few system libraries that are not installed on this computer."
#define COPY_INSTALL_LEAD "Open a terminal, run this command, then start FlowMic again:"
#define COPY_MISSING_LIST "Missing:"
#define COPY_INCOMPLETE "Some FlowMic files are missing. Download FlowMic again and extract the whole folder."
#define INSTALL_COMMAND \
    "sudo apt install libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libsoup-3.0-0 libayatana-appindicator3-1"
/* ---------------------------- end of copy ------------------------------- */

struct runtime_lib {
    const char *package;
    const char *sonames[3]; /* any one of these is enough; NULL-terminated */
};

static const struct runtime_lib REQUIRED_LIBS[] = {
    {"libwebkit2gtk-4.1-0", {"libwebkit2gtk-4.1.so.0", NULL}},
    {"libjavascriptcoregtk-4.1-0", {"libjavascriptcoregtk-4.1.so.0", NULL}},
    {"libsoup-3.0-0", {"libsoup-3.0.so.0", NULL}},
    /* Not in DT_NEEDED: the tray library is dlopen'd by the app at runtime and
     * it fails with "Failed to load ayatana-appindicator3 or appindicator3
     * dynamic library" when neither is present (libappindicator-sys 0.9.0,
     * src/lib.rs). Stock on 22.04, but not on every desktop. */
    {"libayatana-appindicator3-1", {"libayatana-appindicator3.so.1", "libappindicator3.so.1", NULL}},
};

static int trace_enabled(void) {
    const char *value = getenv("FLOWMIC_LAUNCHER_TRACE");
    return value && strcmp(value, "1") == 0;
}

static void trace(const char *what) {
    if (trace_enabled()) fprintf(stderr, "flowmic-launcher: %s\n", what);
}

/* Run a notifier and wait for it. Returns 1 when it showed the message, i.e.
 * it exited with a status in [0, max_shown_status]: zenity exits 1 when the
 * user closes the dialog (still shown); notify-send and xmessage exit non-zero
 * when they could not reach a notification daemon or the display. */
static int run_notifier(char *const argv[], int max_shown_status) {
    pid_t pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        execvp(argv[0], argv);
        _exit(127);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) return 0;
    if (!WIFEXITED(status)) return 0;
    return WEXITSTATUS(status) <= max_shown_status;
}

static int has_display(void) {
    const char *x11 = getenv("DISPLAY");
    const char *wayland = getenv("WAYLAND_DISPLAY");
    return (x11 && *x11) || (wayland && *wayland);
}

/* stderr always; then the first graphical notifier that works. */
static void show_message(const char *body) {
    fprintf(stderr, "%s\n\n%s\n", COPY_TITLE, body);
    if (!has_display()) {
        trace("notifier=stderr (no DISPLAY or WAYLAND_DISPLAY)");
        return;
    }
    char *zenity[] = {"zenity", "--error", "--no-markup", "--title=" COPY_TITLE, "--width=560",
                      "--text", (char *)body, NULL};
    if (run_notifier(zenity, 1)) {
        trace("notifier=zenity");
        return;
    }
    char *notify[] = {"notify-send", "--urgency=critical", COPY_TITLE, (char *)body, NULL};
    if (run_notifier(notify, 0)) {
        trace("notifier=notify-send");
        return;
    }
    char *xmessage[] = {"xmessage", "-center", (char *)body, NULL};
    if (run_notifier(xmessage, 0)) {
        trace("notifier=xmessage");
        return;
    }
    trace("notifier=stderr (no graphical notifier could be started)");
}

static int library_present(const char *soname) {
    void *handle = dlopen(soname, RTLD_LAZY | RTLD_LOCAL);
    if (!handle) return 0;
    dlclose(handle);
    return 1;
}

int main(int argc, char *argv[]) {
    (void)argc;
    char self[PATH_MAX];
    ssize_t length = readlink("/proc/self/exe", self, sizeof self - 1);
    if (length <= 0) {
        fprintf(stderr, "flowmic-launcher: cannot read /proc/self/exe: %s\n", strerror(errno));
        show_message(COPY_INCOMPLETE);
        return 127;
    }
    self[length] = '\0';
    char *slash = strrchr(self, '/');
    if (!slash) return 127;
    *slash = '\0';

    char real[PATH_MAX];
    if (snprintf(real, sizeof real, "%s/%s", self, REAL_BINARY_NAME) >= (int)sizeof real) return 127;

    char missing[1024] = "";
    size_t used = 0;
    for (size_t i = 0; i < sizeof REQUIRED_LIBS / sizeof REQUIRED_LIBS[0]; i++) {
        int found = 0;
        for (size_t j = 0; REQUIRED_LIBS[i].sonames[j]; j++) {
            if (library_present(REQUIRED_LIBS[i].sonames[j])) {
                found = 1;
                break;
            }
        }
        if (!found) {
            int wrote = snprintf(missing + used, sizeof missing - used, "%s%s", used ? ", " : "",
                                 REQUIRED_LIBS[i].sonames[0]);
            if (wrote > 0 && (size_t)wrote < sizeof missing - used) used += (size_t)wrote;
        }
    }
    if (used > 0) {
        char body[2048];
        snprintf(body, sizeof body, "%s\n\n%s\n\n%s\n\n%s %s", COPY_MISSING_LEAD, COPY_INSTALL_LEAD,
                 INSTALL_COMMAND, COPY_MISSING_LIST, missing);
        show_message(body);
        return 127;
    }

    trace("libraries present; exec");
    execv(real, argv);
    fprintf(stderr, "flowmic-launcher: cannot start %s: %s\n", real, strerror(errno));
    show_message(COPY_INCOMPLETE);
    return 127;
}
