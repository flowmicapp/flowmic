/* SPEC-REF: Linux L-3/L-4 acceptance. A separate real GTK process owns formats
 * and exposes a real TextView. Its buffer/property reads are the oracle; no
 * clipboard data or key result is synthesized by the Rust test seam. */
#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static char *directory;
static GtkClipboard *clipboard;
static GtkWidget *window, *view;
static gint64 started;
static char *copy_override;
static char *last_text, *undo_text;
static gboolean undoing;
static guchar large[1024 * 1024];

static void put(const char *name, const void *data, gssize length) {
    char *path = g_build_filename(directory, name, NULL);
    g_file_set_contents(path, data, length, NULL);
    g_free(path);
}

static void get_clipboard(GtkClipboard *clip, GtkSelectionData *selection,
                          guint info, gpointer unused) {
    (void)clip; (void)unused;
    gchar *name = gdk_atom_name(gtk_selection_data_get_target(selection));
    char *path = g_build_filename(directory, "requests", NULL);
    FILE *log = fopen(path, "a");
    if (log) { fprintf(log, "%s %lld\n", name, (long long)(g_get_monotonic_time() - started) / 1000); fclose(log); }
    g_free(path); g_free(name);
    const guchar text[] = "original \xE4\xB8\xAD\xE6\x96\x87 \xF0\x9F\x98\x80";
    const guint16 short_data[] = {0x1234, 0xFEDC, 0};
    const gulong long_data[] = {0x12345678, 0xFEDCBA98, 0};
    switch (info) {
        case 0: gtk_selection_data_set(selection, gdk_atom_intern_static_string("UTF8_STRING"), 8, copy_override ? (const guchar *)copy_override : text, copy_override ? (gint)strlen(copy_override) : (gint)sizeof(text)-1); break;
        case 1: gtk_selection_data_set(selection, gdk_atom_intern_static_string("text/html"), 8, (const guchar *)"<b>original</b>", 15); break;
        case 2: gtk_selection_data_set(selection, gdk_atom_intern_static_string("application/x-flowmic16"), 16, (const guchar *)short_data, sizeof(short_data)); break;
        case 3: gtk_selection_data_set(selection, gdk_atom_intern_static_string("application/x-flowmic32"), 32, (const guchar *)long_data, sizeof(long_data)); break;
        case 4: gtk_selection_data_set(selection, gdk_atom_intern_static_string("application/x-flowmic-large"), 8, large, sizeof(large)); break;
        default: put("unsafe-request", "ERROR", -1); break;
    }
}

static void clear_clipboard(GtkClipboard *clip, gpointer unused) { (void)clip; (void)unused; }

static void buffer_changed(GtkTextBuffer *buffer, gpointer unused) {
    (void)unused;
    GtkTextIter begin, end;
    gtk_text_buffer_get_bounds(buffer, &begin, &end);
    char *text = gtk_text_buffer_get_text(buffer, &begin, &end, FALSE);
    if (!undoing) { g_free(undo_text); undo_text = g_strdup(last_text ? last_text : ""); }
    g_free(last_text); last_text = g_strdup(text);
    put("buffer", text, -1);
    char time[64]; g_snprintf(time, sizeof(time), "%lld", (long long)(g_get_monotonic_time() - started) / 1000);
    put("buffer-ms", time, -1);
    g_free(text);
}

static gboolean key_pressed(GtkWidget *widget, GdkEventKey *event, gpointer unused) {
    (void)widget; (void)unused;
    if ((event->state & GDK_CONTROL_MASK) && event->keyval == GDK_KEY_z && undo_text) {
        char *restore = g_strdup(undo_text); undoing = TRUE;
        gtk_text_buffer_set_text(gtk_text_view_get_buffer(GTK_TEXT_VIEW(view)), restore, -1);
        undoing = FALSE; g_free(restore); return TRUE;
    }
    return FALSE;
}

static gboolean command(gpointer unused) {
    (void)unused;
    char *path = g_build_filename(directory, "command", NULL), *body = NULL;
    if (!g_file_get_contents(path, &body, NULL, NULL)) { g_free(path); return TRUE; }
    unlink(path); g_free(path);
    if (g_str_has_prefix(body, "read:")) {
        GtkSelectionData *data = gtk_clipboard_wait_for_contents(clipboard, gdk_atom_intern(body + 5, FALSE));
        if (data && gtk_selection_data_get_length(data) >= 0) {
            if (gtk_selection_data_get_format(data) == 32) {
                /* GDK may sign-extend the 32-bit wire word on LP64. Only its
                 * low 32 bits belong to the selection; normalize the oracle. */
                gsize count = gtk_selection_data_get_length(data) / sizeof(gulong);
                const gulong *native = (const gulong *)gtk_selection_data_get_data(data);
                guint32 *words = g_new(guint32, count);
                for (gsize i = 0; i < count; ++i) words[i] = GUINT32_TO_LE((guint32)native[i]);
                put("result", words, count * sizeof(guint32)); g_free(words);
            } else put("result", gtk_selection_data_get_data(data), gtk_selection_data_get_length(data));
            char info[64]; g_snprintf(info, sizeof(info), "%d", gtk_selection_data_get_format(data));
            put("format", info, -1);
        } else put("result-error", "conversion refused", -1);
        if (data) gtk_selection_data_free(data);
    } else if (g_str_has_prefix(body, "copy-same-timestamp:")) {
        /* A real server ownership generation with the same GTK window and
         * owner's cached TIMESTAMP. Only XFixes can close this race. */
        g_free(copy_override); copy_override = g_strdup(body + 20);
        GdkWindow *owner = gdk_selection_owner_get(GDK_SELECTION_CLIPBOARD);
        if (!owner || !gdk_selection_owner_set(owner, GDK_SELECTION_CLIPBOARD, GDK_CURRENT_TIME, FALSE)) return FALSE;
        gdk_display_sync(gdk_display_get_default());
    } else if (g_str_has_prefix(body, "copy:")) {
        gtk_clipboard_set_text(clipboard, body + 5, -1);
    } else if (g_str_has_prefix(body, "block:")) {
        char blocked_time[64]; g_snprintf(blocked_time, sizeof(blocked_time), "%lld", (long long)(g_get_monotonic_time() - started) / 1000);
        put("blocked-ms", blocked_time, -1);
        put("blocked", "1", -1);
        g_usleep(g_ascii_strtoull(body + 6, NULL, 10) * 1000);
    } else if (!strcmp(body, "focus")) {
        gtk_window_present(GTK_WINDOW(window));
        gtk_widget_grab_focus(view);
        gdk_window_focus(gtk_widget_get_window(window), GDK_CURRENT_TIME);
    } else if (g_str_has_prefix(body, "buffer:")) {
        gtk_text_buffer_set_text(gtk_text_view_get_buffer(GTK_TEXT_VIEW(view)), body + 7, -1);
    } else if (!strcmp(body, "quit")) gtk_main_quit();
    put("ack", body, -1);
    g_free(body);
    return TRUE;
}

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);
    if (argc != 2) return 2;
    directory = argv[1]; started = g_get_monotonic_time();
    for (guint i = 0; i < sizeof(large); ++i) large[i] = i % 251;
    clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
    GtkTargetEntry targets[] = {{"UTF8_STRING",0,0},{"text/html",0,1},
        {"application/x-flowmic16",0,2},{"application/x-flowmic32",0,3},
        {"application/x-flowmic-large",0,4},{"DELETE",0,5},{"PIXMAP",0,6}};
    if (!gtk_clipboard_set_with_data(clipboard, targets, G_N_ELEMENTS(targets), get_clipboard, clear_clipboard, NULL)) return 3;
    window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), "FlowMic Linux acceptance peer");
    gtk_window_set_default_size(GTK_WINDOW(window), 450, 180);
    view = gtk_text_view_new(); gtk_container_add(GTK_CONTAINER(window), view);
    g_signal_connect(gtk_text_view_get_buffer(GTK_TEXT_VIEW(view)), "changed", G_CALLBACK(buffer_changed), NULL);
    g_signal_connect(view, "key-press-event", G_CALLBACK(key_pressed), NULL);
    if (g_getenv("FLOWMIC_GTK_CLIPBOARD_ONLY")) gtk_widget_realize(window);
    else gtk_widget_show_all(window);
    char xid[64]; g_snprintf(xid, sizeof(xid), "%lu", GDK_WINDOW_XID(gtk_widget_get_window(window)));
    put("xid", xid, -1);
    put("ready", "GTK X11 peer ready", -1);
    g_timeout_add(5, command, NULL);
    gtk_main();
    return 0;
}
