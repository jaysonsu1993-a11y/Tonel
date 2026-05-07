using System.Windows;

namespace TonelWindows.Views;

public partial class SwitchRoomSheet : Window
{
    public string RoomId { get; private set; } = "";

    public SwitchRoomSheet() { InitializeComponent(); }

    private void OnCancel(object sender, RoutedEventArgs e) => DialogResult = false;

    private void OnOk(object sender, RoutedEventArgs e)
    {
        var rid = (RoomIdBox.Text ?? "").Trim();
        if (string.IsNullOrEmpty(rid)) return;
        RoomId = rid;
        DialogResult = true;
    }
}
