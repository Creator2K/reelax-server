// 注册：用户名 + 口令即可，不再要求邮箱
//
// 为什么去掉邮箱：这是自建服务，不会给用户发任何邮件，邮箱只是个多余的必填项。
// 登录标识统一叫「用户名」（历史上注册的邮箱用户照常能登录，因为那一列只存字符串）。
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { IconCircleCheck, IconLoader2 } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { AuthShell } from "@/components/layout/AuthShell.tsx";
import { useAuthActions, useSystemInfo } from "@/lib/session.ts";
import { ApiError } from "@/lib/api.ts";

const schema = z.object({
  username: z
    .string()
    .min(3, "用户名至少 3 个字符")
    .max(32, "用户名最多 32 个字符")
    .regex(/^[^\s<>/\\'"`|]+$/, "用户名不能包含空格或 < > / \\ ' \" ` | 这些字符"),
  // 显示名可选：不填就用用户名
  displayName: z.string().max(40, "显示名最多 40 个字符").optional(),
  password: z.string().min(8, "口令至少 8 个字符").max(200, "口令过长"),
  inviteCode: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export default function RegisterPage() {
  const navigate = useNavigate();
  const { register: registerUser } = useAuthActions();
  const { data: system } = useSystemInfo();
  const [formError, setFormError] = useState<string | null>(null);
  const [becameAdmin, setBecameAdmin] = useState(false);
  const [registered, setRegistered] = useState(false);

  const isFirstUser = system?.hasUsers === false;
  const registrationOpen = system?.allowRegistration !== false;
  // 后台可以关掉「注册需要邀请码」，此时不再显示邀请码输入框
  const needInvite = system?.requireInvite !== false && !isFirstUser;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: "", displayName: "", password: "", inviteCode: "" },
  });

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    try {
      const res = await registerUser({
        username: values.username.trim(),
        password: values.password,
        ...(values.displayName?.trim() ? { displayName: values.displayName.trim() } : {}),
        ...(values.inviteCode?.trim() ? { inviteCode: values.inviteCode.trim() } : {}),
      });
      setBecameAdmin(res.becameAdmin);
      setRegistered(true);
      // 首个用户已是管理员，直接进控制台
      if (res.becameAdmin) navigate("/", { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "注册失败，请稍后再试");
    }
  };

  if (registered && !becameAdmin) {
    return (
      <AuthShell title="注册成功" description="可以开始使用了">
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <IconCircleCheck className="size-5" />
          </div>
          <p className="text-muted-foreground text-sm">
            账号已创建，现在就可以添加游戏账号并开始挂机。
          </p>
        </div>
        <Button className="mt-4 w-full" onClick={() => navigate("/", { replace: true })}>
          进入控制台
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="注册" description={isFirstUser ? "你是第一个注册者，将自动成为管理员" : undefined}>
      {!registrationOpen ? (
        <Alert variant="warn">
          <AlertDescription>本服务已关闭自助注册，请联系管理员创建账号。</AlertDescription>
        </Alert>
      ) : null}

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="username">用户名</Label>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            placeholder="登录时用它，例如 xiaowang"
            {...register("username")}
          />
          {errors.username ? (
            <p className="text-destructive text-xs">{errors.username.message}</p>
          ) : (
            <p className="text-muted-foreground text-xs">3~32 个字符，不带空格</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="displayName">显示名（可不填）</Label>
          <Input id="displayName" autoComplete="nickname" placeholder="界面里怎么称呼你" {...register("displayName")} />
          {errors.displayName ? <p className="text-destructive text-xs">{errors.displayName.message}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">口令</Label>
          <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
          {errors.password ? (
            <p className="text-destructive text-xs">{errors.password.message}</p>
          ) : (
            <p className="text-muted-foreground text-xs">至少 8 个字符</p>
          )}
        </div>

        {needInvite ? (
          <div className="space-y-2">
            <Label htmlFor="inviteCode">邀请码</Label>
            <Input id="inviteCode" placeholder="由管理员生成" {...register("inviteCode")} />
            {errors.inviteCode ? <p className="text-destructive text-xs">{errors.inviteCode.message}</p> : null}
          </div>
        ) : null}

        <Button type="submit" className="w-full" disabled={isSubmitting || !registrationOpen}>
          {isSubmitting ? <IconLoader2 className="animate-spin" /> : null}
          注册
        </Button>

        <p className="text-muted-foreground text-center text-sm">
          已有账号？
          <Link to="/login" className="text-foreground underline underline-offset-4">
            去登录
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
