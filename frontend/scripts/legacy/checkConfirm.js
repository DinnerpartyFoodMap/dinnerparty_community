const fs = require('fs');

const files = [
    "src/settings/Settings.jsx",
    "src/map/MapView.jsx",
    'src/admin/AdminUsers.jsx',
    'src/admin/AdminPlaces.jsx',
    'src/admin/AdminComments.jsx',
    'src/admin/AdminInvitecodes.jsx',
    'src/admin/AdminGeneralUsers.jsx'
];

for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, 'utf8');

    if (content.includes('window.confirm')) {
        let importPath = "'../components/Confirm'";
        if (file === "src/settings/Settings.jsx" || file === "src/map/MapView.jsx") {
            importPath = "'./components/Confirm'";
        }

        if (!content.includes('useConfirm')) {
            content = `import { useConfirm } from ${importPath};\n` + content;
        }

        // We need to find the components that need useConfirm initialized.
        // Actually, we need to manually inspect each because changing synchronous logic to async/await can be tricky.
        console.log(file + " uses window.confirm");
    }
}
