import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { IconLoader2 } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { AuthShell } from "@/components/layout/AuthShell.tsx";
import { useAuthActions } from "@/lib/session.ts";
import { ApiError } from "@/lib/api.ts";

// 登录标识允许两种：邮箱（普通用户）或登录名（管理员默认是 admin）。
// 早期这里写死 .email() 校验，导致内置管理员用 admin 登录时被前端拦下报
// 「邮箱格式不正确」—— 后端本来是按同一个字段匹配的，前端的限制纯属多余。
const schema = z.object({
  identity: z.string().min(1, "请输入邮箱或登录名"),
  password: z.string().min(1, "请输入口令"),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuthActions();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { identity: "", password: "" } });

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    try {
      await login(values.identity, values.password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== "/login" ? from : "/", { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "登录失败，请稍后再试");
    }
  };

  return (
    <AuthShell title="登录" description="登录后即可管理你的游戏账号与挂机功能">
      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          {/* 用 text 而不是 email：管理员登录名是 admin，不是邮箱 */}
          <Label htmlFor="identity">邮箱或登录名</Label>
          <Input
            id="identity"
            type="text"
            autoComplete="username"
            placeholder="you@example.com 或 admin"
            {...register("identity")}
          />
          {errors.identity ? <p className="text-destructive text-xs">{errors.identity.message}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">口令</Label>
          <Input id="password" type="password" autoComplete="current-password" {...register("password")} />
          {errors.password ? <p className="text-destructive text-xs">{errors.password.message}</p> : null}
        </div>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? <IconLoader2 className="animate-spin" /> : null}
          登录
        </Button>

        <p className="text-muted-foreground text-center text-sm">
          还没有账号？
          <Link to="/register" className="text-foreground underline underline-offset-4">
            用邀请码注册
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
