import { exec } from 'child_process';

function sendQ() {
    exec('powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys(\'q\')"', (error) => {
        if (error) {
            console.error(`Erreur: ${error.message}`);
        }
    });
}

export default sendQ;