#include <napi.h>
#include <windows.h>
#include <VersionHelpers.h>
#include <thread>
#include <chrono>

void DebugLog(const wchar_t* message) {
    OutputDebugStringW(message);
    OutputDebugStringW(L"\n");
}

class StealthMode : public Napi::ObjectWrap<StealthMode> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    StealthMode(const Napi::CallbackInfo& info);

private:
    Napi::Value EnableStealthMode(const Napi::CallbackInfo& info);
    Napi::Value DisableStealthMode(const Napi::CallbackInfo& info);
    void MonitorAffinity(HWND hwnd);

    bool isRunning = false;
    std::thread monitorThread;
};

StealthMode::StealthMode(const Napi::CallbackInfo& info) : Napi::ObjectWrap<StealthMode>(info) {
    DebugLog(L"StealthMode constructor called");
}

Napi::Object StealthMode::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "StealthMode", {
        InstanceMethod("enableStealthMode", &StealthMode::EnableStealthMode),
        InstanceMethod("disableStealthMode", &StealthMode::DisableStealthMode)
    });

    Napi::FunctionReference* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    env.SetInstanceData(constructor);

    exports.Set("StealthMode", func);
    DebugLog(L"StealthMode initialized");
    return exports;
}

bool IsSetWindowDisplayAffinitySupported() {
    bool supported = IsWindows8Point1OrGreater();
    DebugLog(supported ? L"Windows 8.1 or greater detected" : L"Windows version does not support WDA_EXCLUDEFROMCAPTURE");
    return supported;
}

Napi::Value StealthMode::EnableStealthMode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || (!info[0].IsNumber() && !info[0].IsBigInt())) {
        DebugLog(L"EnableStealthMode: Invalid HWND argument");
        Napi::TypeError::New(env, "Expected HWND as number or BigInt").ThrowAsJavaScriptException();
        return env.Null();
    }

    HWND hwnd;
    if (info[0].IsBigInt()) {
        bool lossless;
        hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::BigInt>().Int64Value(&lossless)));
        if (!lossless) {
            DebugLog(L"EnableStealthMode: BigInt to uintptr_t conversion failed");
            Napi::TypeError::New(env, "BigInt conversion failed").ThrowAsJavaScriptException();
            return env.Null();
        }
    } else {
        hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
    }

    wchar_t hwndLog[256];
    swprintf_s(hwndLog, L"EnableStealthMode: Attempting with HWND %p", hwnd);
    DebugLog(hwndLog);

    if (!IsSetWindowDisplayAffinitySupported()) {
        DebugLog(L"EnableStealthMode: OS does not support stealth mode");
        Napi::Error::New(env, "Stealth mode not supported on this Windows version").ThrowAsJavaScriptException();
        return env.Null();
    }

    BOOL success = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    if (!success) {
        DWORD error = GetLastError();
        wchar_t errorMsg[256];
        swprintf_s(errorMsg, L"EnableStealthMode: SetWindowDisplayAffinity failed with error %u", error);
        DebugLog(errorMsg);
        Napi::Error::New(env, "Failed to enable stealth mode").ThrowAsJavaScriptException();
        return env.Null();
    }

    DebugLog(L"EnableStealthMode: SetWindowDisplayAffinity succeeded");
    if (!isRunning) {
        isRunning = true;
        monitorThread = std::thread(&StealthMode::MonitorAffinity, this, hwnd);
        monitorThread.detach();
        DebugLog(L"EnableStealthMode: Monitoring thread started");
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value StealthMode::DisableStealthMode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || (!info[0].IsNumber() && !info[0].IsBigInt())) {
        DebugLog(L"DisableStealthMode: Invalid HWND argument");
        Napi::TypeError::New(env, "Expected HWND as number or BigInt").ThrowAsJavaScriptException();
        return env.Null();
    }

    HWND hwnd;
    if (info[0].IsBigInt()) {
        bool lossless;
        hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::BigInt>().Int64Value(&lossless)));
        if (!lossless) {
            DebugLog(L"DisableStealthMode: BigInt to uintptr_t conversion failed");
            Napi::TypeError::New(env, "BigInt conversion failed").ThrowAsJavaScriptException();
            return env.Null();
        }
    } else {
        hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
    }

    wchar_t hwndLog[256];
    swprintf_s(hwndLog, L"DisableStealthMode: Attempting with HWND %p", hwnd);
    DebugLog(hwndLog);

    BOOL success = SetWindowDisplayAffinity(hwnd, WDA_NONE);
    if (!success) {
        DWORD error = GetLastError();
        wchar_t errorMsg[256];
        swprintf_s(errorMsg, L"DisableStealthMode: SetWindowDisplayAffinity failed with error %u", error);
        DebugLog(errorMsg);
        Napi::Error::New(env, "Failed to disable stealth mode").ThrowAsJavaScriptException();
        return env.Null();
    }

    DebugLog(L"DisableStealthMode: SetWindowDisplayAffinity succeeded");
    isRunning = false;
    return Napi::Boolean::New(env, true);
}

void StealthMode::MonitorAffinity(HWND hwnd) {
    DebugLog(L"MonitorAffinity: Thread started");
    while (isRunning) {
        if (IsSetWindowDisplayAffinitySupported()) {
            BOOL success = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            if (success) {
                DebugLog(L"MonitorAffinity: Reapplied WDA_EXCLUDEFROMCAPTURE");
            } else {
                DWORD error = GetLastError();
                wchar_t errorMsg[256];
                swprintf_s(errorMsg, L"MonitorAffinity: Reapply failed with error %u", error);
                DebugLog(errorMsg);
            }
        }
        std::this_thread::sleep_for(std::chrono::seconds(5));
    }
    DebugLog(L"MonitorAffinity: Thread stopped");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return StealthMode::Init(env, exports);
}

NODE_API_MODULE(stealth, Init)
